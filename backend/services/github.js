import { App } from "@octokit/app";

const MAX_DIFF_LINES = 500;

function truncatePatch(patch = "") {
  const lines = patch.split("\n");
  if (lines.length <= MAX_DIFF_LINES) {
    return patch;
  }

  return (
    lines.slice(0, MAX_DIFF_LINES).join("\n") +
    `\n... (truncated ${lines.length - MAX_DIFF_LINES} lines)`
  );
}

function buildSyntheticDiff(file) {
  const previousFilename = file.previous_filename ?? file.filename;
  const oldPath = file.status === "added" ? "/dev/null" : previousFilename;
  const newPath = file.status === "removed" ? "/dev/null" : file.filename;
  const patch = truncatePatch(file.patch ?? "");
  const header = [
    `diff --git a/${previousFilename} b/${file.filename}`,
  ];

  if (file.previous_filename && file.previous_filename !== file.filename) {
    header.push(`rename from ${file.previous_filename}`);
    header.push(`rename to ${file.filename}`);
  }

  header.push(oldPath === "/dev/null" ? "--- /dev/null" : `--- a/${oldPath}`);
  header.push(newPath === "/dev/null" ? "+++ /dev/null" : `+++ b/${newPath}`);
  header.push(patch || "@@\nGitHub omitted the patch for this file.");

  return header.join("\n");
}

/**
 * Create an authenticated Octokit instance for a GitHub App installation.
 */
export async function getInstallationClient(installationId) {
  const app = new App({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  });

  return app.getInstallationOctokit(installationId);
}

/**
 * Fetch the diff and metadata for a pull request.
 */
export async function getPRDiff(octokit, owner, repo, prNumber) {
  const prPromise = octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber,
  });
  const filesPromise = octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const [{ data: pr }, { data: files }] = await Promise.all([prPromise, filesPromise]);

  const truncatedFiles = files.map((file) => ({
    filename: file.filename,
    previous_filename: file.previous_filename ?? null,
    patch: truncatePatch(file.patch ?? ""),
    status: file.status,
  }));

  const fullDiff = truncatedFiles.map(buildSyntheticDiff).join("\n\n");

  return {
    title: pr.title,
    author: pr.user?.login ?? "unknown",
    body: pr.body ?? "",
    headSha: pr.head?.sha ?? null,
    state: pr.state,
    files: truncatedFiles,
    fullDiff,
  };
}

/**
 * Find an existing issue comment for a PR by an embedded marker string.
 */
export async function findCommentByMarker(octokit, owner, repo, prNumber, marker) {
  // Fetch comments page by page (octokit from getInstallationOctokit has no .paginate)
  let page = 1;
  while (true) {
    const { data: comments } = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { owner, repo, issue_number: prNumber, per_page: 100, page }
    );

    const match = comments.find(
      (comment) => typeof comment.body === "string" && comment.body.includes(marker)
    );

    if (match) {
      return { id: match.id, body: match.body ?? "" };
    }

    if (comments.length < 100) break;
    page++;
  }

  return null;
}

/**
 * Post a review comment on a pull request as an issue comment.
 */
export async function postReview(octokit, owner, repo, prNumber, reviewBody) {
  const { data: comment } = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    { owner, repo, issue_number: prNumber, body: reviewBody }
  );
  return comment.id;
}

/**
 * Edit an existing comment.
 */
export async function editComment(octokit, owner, repo, commentId, body) {
  await octokit.request(
    "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
    { owner, repo, comment_id: commentId, body }
  );
}

/**
 * Get the default branch name for a repository.
 */
export async function getRepoDefaultBranch(octokit, owner, repo) {
  const { data: repository } = await octokit.request(
    "GET /repos/{owner}/{repo}",
    { owner, repo }
  );
  return repository.default_branch;
}
