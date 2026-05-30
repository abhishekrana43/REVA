import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';

export const oauthRouter = Router();

function getSharedAuthSecret() {
  return (
    process.env.JWT_SECRET ||
    process.env.GITHUB_CLIENT_SECRET ||
    'niargus-dev-secret-change-me'
  );
}

function getAppUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

function createSignedToken(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', getSharedAuthSecret())
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifySignedToken(token) {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createHmac('sha256', getSharedAuthSecret())
    .update(encodedPayload)
    .digest();
  const providedSignature = Buffer.from(signature, 'base64url');

  if (
    expectedSignature.length !== providedSignature.length ||
    !timingSafeEqual(expectedSignature, providedSignature)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );

    if (!payload.exp || payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function buildAppCallbackUrl({ auth, error, state }) {
  const url = new URL('/api/auth/callback', getAppUrl());

  if (state) {
    url.searchParams.set('state', state);
  }
  if (auth) {
    url.searchParams.set('auth', auth);
  }
  if (error) {
    url.searchParams.set('error', error);
  }

  return url.toString();
}

async function exchangeCodeForAccessToken(code) {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    throw new Error('GitHub OAuth is not configured');
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
    throw new Error(tokenData.error_description || 'GitHub token exchange failed');
  }

  return tokenData.access_token;
}

async function fetchGitHubJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'NiArgus',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status})`);
  }

  return response.json();
}

async function getAccessibleInstallationIds(accessToken) {
  const installationIds = new Set();
  let page = 1;

  while (true) {
    const data = await fetchGitHubJson(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      accessToken,
    );
    const installations = Array.isArray(data.installations)
      ? data.installations
      : [];

    for (const installation of installations) {
      if (installation?.id) {
        installationIds.add(Number(installation.id));
      }
    }

    if (installations.length < 100) {
      break;
    }

    page += 1;
  }

  return Array.from(installationIds).filter(
    (installationId) => Number.isInteger(installationId) && installationId > 0,
  );
}

// GitHub OAuth callback — exchanges code for access token
oauthRouter.get('/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;

  if (!code || !state) {
    return res.redirect(
      buildAppCallbackUrl({
        error: 'missing_code_or_state',
        state,
      }),
    );
  }

  if (!verifySignedToken(state)) {
    return res.redirect(
      buildAppCallbackUrl({
        error: 'invalid_state',
        state,
      }),
    );
  }

  try {
    const accessToken = await exchangeCodeForAccessToken(code);
    const user = await fetchGitHubJson('https://api.github.com/user', accessToken);
    const installationIds = await getAccessibleInstallationIds(accessToken);

    if (!user?.login) {
      throw new Error('GitHub user lookup failed');
    }

    console.log(
      `[oauth] User authenticated: ${user.login} (${installationIds.length} installs)`,
    );

    res.redirect(
      buildAppCallbackUrl({
        auth: createSignedToken({
          login: user.login,
          avatar: user.avatar_url || '',
          installationIds,
          exp: Date.now() + 60 * 1000,
        }),
        state,
      }),
    );
  } catch (err) {
    console.error('[oauth] Error:', err);
    res.redirect(
      buildAppCallbackUrl({
        error: 'oauth_failed',
        state,
      }),
    );
  }
});
