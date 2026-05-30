import { Router } from 'express';
import crypto from 'crypto';
import {
  getInstallationClient,
  getPRDiff,
  postReview,
  editComment,
  findCommentByMarker,
} from '../services/github.js';
import { indexRepo, buildContextForDiff } from '../services/nia.js';
import { generateReview } from '../services/reviewer.js';
import {
  listInstallationIds,
  upsertInstallation,
  upsertRepo,
  updateRepoNiaSource,
  setRepoEnabledByGithubId,
  enqueueReviewJob,
  claimNextReviewJob,
  getReviewJobById,
  setReviewCommentId,
  renewReviewJobLease,
  completeReviewJob,
  markReviewJobErrored,
  markReviewJobSuperseded,
} from '../services/db.js';

const processingInstallations = new Set();
const scheduledDrains = new Map();
const installationRetryTimers = new Map();

export const webhookRouter = Router();

const NIARGUS_PR_MARKER = '<!-- niargus-pr-review -->';
const ERROR_MESSAGE = "⚠️ **NiArgus** encountered an issue reviewing this PR. We'll automatically retry when you push a new commit.";

function reviewMarker(reviewId) {
  return `<!-- niargus-review-job:${reviewId} -->`;
}

function withReviewMarker(reviewId, body) {
  return `${NIARGUS_PR_MARKER}\n${reviewMarker(reviewId)}\n${body}`;
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : 'unknown';
}

function retryDelayMs(attemptCount) {
  return Math.min(2 ** Math.max(attemptCount - 1, 0), 30) * 60 * 1000;
}

function scheduleDrain(installationId, delayMs = 0) {
  if (!installationId) {
    return;
  }

  const existing = scheduledDrains.get(installationId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    scheduledDrains.delete(installationId);
    drainReviewQueue(installationId).catch((err) => {
      console.error(`[review] Error draining queued jobs for installation ${installationId}:`, err);
    });
  }, Math.max(delayMs, 0));

  timer.unref?.();
  scheduledDrains.set(installationId, timer);
}

// ── Signature verification ──────────────────────────────────────────────

function verifySignature(payload, signature) {
  if (!signature || !process.env.GITHUB_WEBHOOK_SECRET) return false;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function clearInstallationRetry(installationId) {
  const timer = installationRetryTimers.get(installationId);
  if (timer) {
    clearTimeout(timer);
    installationRetryTimers.delete(installationId);
  }
}

function scheduleInstallationRetry(installationId, delayMs = 5 * 60 * 1000) {
  if (installationRetryTimers.has(installationId)) {
    return;
  }

  const timer = setTimeout(() => {
    installationRetryTimers.delete(installationId);
    drainReviewQueue(installationId).catch((error) => {
      console.error(`[review] Retry drain failed for installation ${installationId}:`, error);
      scheduleInstallationRetry(installationId, delayMs);
    });
  }, delayMs);

  installationRetryTimers.set(installationId, timer);
}

// ── Webhook handler ─────────────────────────────────────────────────────

webhookRouter.post('/', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const payload = req.body;

  if (!verifySignature(payload, signature)) {
    console.log('[webhook] Invalid signature — rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  const body = JSON.parse(payload.toString());
  const action = body.action;

  console.log(`[webhook] ${event}.${action}`);

  try {
    if (event === 'pull_request' && (action === 'opened' || action === 'synchronize')) {
      const queuedReview = await handlePullRequest(body);
      res.status(queuedReview.queued ? 202 : 200).json({
        ok: true,
        queued: queuedReview.queued,
        reviewId: queuedReview.reviewId ?? null,
        reason: queuedReview.reason ?? null,
      });

      if (queuedReview.queued && queuedReview.installationId) {
        void drainReviewQueue(queuedReview.installationId).catch((error) => {
          console.error(
            `[review] Failed to drain queue for installation ${queuedReview.installationId}:`,
            error,
          );
          scheduleInstallationRetry(queuedReview.installationId);
        });
      }
      return;
    }

    if (event === 'installation' && action === 'created') {
      await handleInstallationCreated(body);
      res.status(200).json({ ok: true });
      return;
    }

    if (event === 'installation_repositories') {
      await handleInstallationRepos(body);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(200).json({ ok: true, ignored: true });
  } catch (err) {
    console.error(`[webhook] Error handling ${event}.${action}:`, err);
    res.status(500).json({ error: 'Failed to handle webhook' });
  }
});

// ── Review queue helpers ────────────────────────────────────────────────

async function ensureReviewComment(job, octokit, owner, repo) {
  let commentId = job.githubCommentId;

  if (!commentId) {
    // First try the job-specific marker (for in-progress restarts)
    const byJob = await findCommentByMarker(octokit, owner, repo, job.prNumber, reviewMarker(job.reviewId));
    if (byJob) {
      commentId = byJob.id;
    }
  }

  if (!commentId) {
    // Then try the PR-level marker (reuse existing NiArgus comment from a previous/failed job)
    const byPr = await findCommentByMarker(octokit, owner, repo, job.prNumber, NIARGUS_PR_MARKER);
    if (byPr) {
      commentId = byPr.id;
      console.log(`[review] Reusing existing NiArgus comment ${commentId} on PR #${job.prNumber}`);
    }
  }

  if (commentId) {
    await setReviewCommentId(job.reviewId, commentId);
  }

  const placeholderBody = withReviewMarker(
    job.reviewId,
    `🔍 **NiArgus** is reviewing commit \`${shortSha(job.headSha)}\`...`
  );

  if (commentId) {
    await editComment(octokit, owner, repo, commentId, placeholderBody);
    return commentId;
  }

  commentId = await postReview(octokit, owner, repo, job.prNumber, placeholderBody);
  await setReviewCommentId(job.reviewId, commentId);
  return commentId;
}

async function updateReviewComment(octokit, owner, repo, reviewId, commentId, body) {
  if (!octokit || !commentId) {
    return;
  }

  await editComment(octokit, owner, repo, commentId, withReviewMarker(reviewId, body));
}

async function stopIfJobIsNoLongerCurrent(job, octokit, owner, repo, commentId) {
  const latestJob = await getReviewJobById(job.reviewId);
  if (latestJob?.status === 'processing') {
    return false;
  }

  if (latestJob?.status === 'superseded') {
    await updateReviewComment(
      octokit,
      owner,
      repo,
      job.reviewId,
      commentId,
      '⏭️ **NiArgus** skipped this run because newer commits arrived.'
    ).catch(() => {});
  }

  return true;
}

async function ensureRepoIndexed(job) {
  if (job.niaSourceId) {
    return job.niaSourceId;
  }

  console.log(`[review] Indexing ${job.repoFullName} in Nia...`);
  const sourceId = await indexRepo(job.repoFullName);
  await updateRepoNiaSource(job.repoId, sourceId);
  return sourceId;
}

async function processReviewJob(job) {
  const [owner, repo] = job.repoFullName.split('/');
  let octokit;
  let commentId = job.githubCommentId;

  try {
    octokit = await getInstallationClient(job.githubInstallationId);
    commentId = await ensureReviewComment(job, octokit, owner, repo);
    await renewReviewJobLease(job.reviewId);

    const diff = await getPRDiff(octokit, owner, repo, job.prNumber);
    console.log(
      `[review] Claimed ${job.reviewId} for ${job.repoFullName}#${job.prNumber} ` +
      `(${diff.files.length} files, attempt ${job.attemptCount})`
    );

    if (diff.state !== 'open') {
      await markReviewJobSuperseded(job.reviewId, `Pull request is ${diff.state}.`);
      await updateReviewComment(
        octokit,
        owner,
        repo,
        job.reviewId,
        commentId,
        '⏹️ **NiArgus** skipped this run because the pull request is no longer open.'
      ).catch(() => {});
      return;
    }

    if (diff.headSha && job.headSha && diff.headSha !== job.headSha) {
      await markReviewJobSuperseded(
        job.reviewId,
        `New head commit ${diff.headSha} replaced ${job.headSha}.`
      );
      await enqueueReviewJob({
        repoId: job.repoId,
        prNumber: job.prNumber,
        headSha: diff.headSha,
        prTitle: diff.title,
        prAuthor: diff.author,
      });
      await updateReviewComment(
        octokit,
        owner,
        repo,
        job.reviewId,
        commentId,
        '⏭️ **NiArgus** skipped this run because a newer commit arrived and was re-queued.'
      ).catch(() => {});
      return;
    }

    if (await stopIfJobIsNoLongerCurrent(job, octokit, owner, repo, commentId)) {
      return;
    }

    const sourceId = await ensureRepoIndexed(job);
    await renewReviewJobLease(job.reviewId);

    console.log('[review] Building context from codebase...');
    const contextChunks = await buildContextForDiff(sourceId, diff.fullDiff);
    console.log(`[review] Got ${contextChunks.length} context chunks`);

    if (await stopIfJobIsNoLongerCurrent(job, octokit, owner, repo, commentId)) {
      return;
    }

    await renewReviewJobLease(job.reviewId);
    console.log('[review] Generating review with Claude...');
    const reviewBody = await generateReview(
      diff.fullDiff,
      contextChunks,
      diff.title,
      diff.author
    );

    if (await stopIfJobIsNoLongerCurrent(job, octokit, owner, repo, commentId)) {
      return;
    }

    await updateReviewComment(octokit, owner, repo, job.reviewId, commentId, reviewBody);
    const completed = await completeReviewJob(job.reviewId, {
      prTitle: diff.title,
      prAuthor: diff.author,
      reviewBody,
      filesChanged: diff.files.length,
      contextFilesUsed: contextChunks.length,
      githubCommentId: commentId,
    });

    if (!completed) {
      await updateReviewComment(
        octokit,
        owner,
        repo,
        job.reviewId,
        commentId,
        '⏭️ **NiArgus** skipped this run because newer commits arrived.'
      ).catch(() => {});
      return;
    }

    console.log(`[review] Posted review on PR #${job.prNumber}`);
  } catch (err) {
    console.error(`[review] Error reviewing job ${job.reviewId}:`, err);

    const message = err?.message ?? String(err);
    const failedJob = await markReviewJobErrored(job.reviewId, message);

    if (failedJob?.status === 'superseded') {
      await updateReviewComment(
        octokit,
        owner,
        repo,
        job.reviewId,
        commentId,
        '⏭️ **NiArgus** skipped this run because newer commits arrived.'
      ).catch(() => {});
      return;
    }

    const retrying = failedJob?.status === 'queued';
    if (retrying) {
      scheduleDrain(
        job.installationId,
        retryDelayMs(Number(failedJob?.attempt_count ?? job.attemptCount))
      );
    }

    await updateReviewComment(
      octokit,
      owner,
      repo,
      job.reviewId,
      commentId,
      retrying
        ? '⚠️ **NiArgus** hit a temporary error while reviewing this PR. It will retry shortly.'
        : ERROR_MESSAGE
    ).catch(() => {});
  }
}

async function drainReviewQueue(installationId) {
  const scheduled = scheduledDrains.get(installationId);
  if (scheduled) {
    clearTimeout(scheduled);
    scheduledDrains.delete(installationId);
  }

  if (processingInstallations.has(installationId)) {
    return;
  }

  clearInstallationRetry(installationId);
  processingInstallations.add(installationId);

  try {
    while (true) {
      const job = await claimNextReviewJob(installationId);
      if (!job) {
        return;
      }

      if (!job.reviewId) {
        const retryDelay = job.reason?.startsWith('Monthly') ? 60 * 60 * 1000 : 5 * 60 * 1000;
        scheduleDrain(job.installationId ?? installationId, retryDelay);
        console.log(
          `[review] Queue paused for installation ${installationId}: ${job.reason} ` +
          `(monthly: ${job.monthlyUsed}/50, hourly: ${job.hourlyUsed}/10)`
        );
        scheduleInstallationRetry(installationId);
        return;
      }

      await processReviewJob(job);
    }
  } finally {
    processingInstallations.delete(installationId);
  }
}

// ── Pull request review flow ────────────────────────────────────────────

async function handlePullRequest(body) {
  const installationAccount = body.installation.account ?? body.repository.owner;
  const installation = await upsertInstallation({
    githubInstallationId: body.installation.id,
    githubAccountLogin: installationAccount.login,
    githubAccountType: installationAccount.type,
  });
  const repoFullName = body.repository.full_name;
  const prNumber = body.pull_request.number;
  const headSha = body.pull_request.head?.sha;

  console.log(`[review] PR #${prNumber} on ${repoFullName} @ ${shortSha(headSha)}`);

  const dbRepo = await upsertRepo({
    installationId: installation.id,
    githubRepoId: body.repository.id,
    fullName: repoFullName,
  });

  if (!dbRepo.is_enabled) {
    console.log(`[review] Repo ${repoFullName} is disabled — skipping`);
    return {
      queued: false,
      installationId: installation.id,
      reason: 'repo_disabled',
    };
  }

  if (!headSha) {
    console.log(`[review] Missing head SHA for ${repoFullName}#${prNumber} — skipping`);
    return {
      queued: false,
      installationId: installation.id,
      reason: 'missing_head_sha',
    };
  }

  const enqueuedJob = await enqueueReviewJob({
    repoId: dbRepo.id,
    prNumber,
    headSha,
    prTitle: body.pull_request.title ?? null,
    prAuthor: body.pull_request.user?.login ?? null,
  });

  console.log(
    `[review] Enqueued job ${enqueuedJob.reviewId} (${enqueuedJob.status}) ` +
    `for ${repoFullName}#${prNumber}; superseded ${enqueuedJob.supersededCount} older run(s)`
  );

  return {
    queued: enqueuedJob.status === 'queued',
    installationId: installation.id,
    reviewId: enqueuedJob.reviewId,
    reason: enqueuedJob.status === 'queued' ? null : enqueuedJob.status,
  };
}

// ── Installation created ────────────────────────────────────────────────

async function handleInstallationCreated(body) {
  const inst = body.installation;
  console.log(`[install] New installation from ${inst.account.login}`);

  const dbInstallation = await upsertInstallation({
    githubInstallationId: inst.id,
    githubAccountLogin: inst.account.login,
    githubAccountType: inst.account.type,
  });

  const repos = body.repositories || [];
  for (const repo of repos) {
    const dbRepo = await upsertRepo({
      installationId: dbInstallation.id,
      githubRepoId: repo.id,
      fullName: repo.full_name,
      isEnabled: true,
    });

    if (!dbRepo.nia_source_id) {
      indexRepo(repo.full_name)
        .then((sourceId) => updateRepoNiaSource(dbRepo.id, sourceId))
        .then(() => console.log(`[install] Indexed ${repo.full_name}`))
        .catch((err) => console.error(`[install] Failed to index ${repo.full_name}:`, err));
    }
  }
}

// ── Installation repos added/removed ────────────────────────────────────

async function handleInstallationRepos(body) {
  const inst = body.installation;
  const dbInstallation = await upsertInstallation({
    githubInstallationId: inst.id,
    githubAccountLogin: inst.account.login,
    githubAccountType: inst.account.type,
  });

  const added = body.repositories_added || [];
  for (const repo of added) {
    console.log(`[repos] Adding ${repo.full_name}`);
    const dbRepo = await upsertRepo({
      installationId: dbInstallation.id,
      githubRepoId: repo.id,
      fullName: repo.full_name,
      isEnabled: true,
    });

    if (!dbRepo.nia_source_id) {
      indexRepo(repo.full_name)
        .then((sourceId) => updateRepoNiaSource(dbRepo.id, sourceId))
        .catch((err) => console.error(`[repos] Failed to index ${repo.full_name}:`, err));
    }
  }

  const removed = body.repositories_removed || [];
  for (const repo of removed) {
    console.log(`[repos] Disabling ${repo.full_name}`);
    await setRepoEnabledByGithubId(repo.id, false, repo.full_name);
  }
}

async function resumeReviewQueues() {
  const installationIds = await listInstallationIds();

  await Promise.all(
    installationIds.map((installationId) =>
      drainReviewQueue(installationId).catch((error) => {
        console.error(`[review] Failed to resume queue for installation ${installationId}:`, error);
        scheduleInstallationRetry(installationId);
      }),
    ),
  );
}

setTimeout(() => {
  resumeReviewQueues().catch((error) => {
    console.error('[review] Failed to resume review queues on startup:', error);
  });
}, 0);
