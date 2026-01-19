import { randomBytes, createHash } from 'crypto';
import express from 'express';
import open from 'open';
import type { TokenData } from '../types/index.js';

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const REDIRECT_URI = 'http://localhost:8888/callback';

// Required scopes for SpotifyFS functionality
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-read',
  'user-read-private',
].join(' ');

function generateCodeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier).digest();
  return hash.toString('base64url');
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

export interface AuthConfig {
  clientId: string;
}

export async function authenticateWithPKCE(config: AuthConfig): Promise<TokenData> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  return new Promise((resolve, reject) => {
    const app = express();
    let server: ReturnType<typeof app.listen>;

    app.get('/callback', async (req, res) => {
      const { code, state: returnedState, error } = req.query;

      if (error) {
        res.send(`<html><body><h1>Authentication Failed</h1><p>${error}</p></body></html>`);
        server.close();
        reject(new Error(`Authentication failed: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.send('<html><body><h1>Authentication Failed</h1><p>State mismatch</p></body></html>');
        server.close();
        reject(new Error('State mismatch - possible CSRF attack'));
        return;
      }

      try {
        const tokenData = await exchangeCodeForToken(
          code as string,
          codeVerifier,
          config.clientId
        );
        res.send(`
          <html>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1DB954;">
              <div style="text-align: center; color: white;">
                <h1>Authentication Successful!</h1>
                <p>You can close this window and return to SpotifyFS.</p>
              </div>
            </body>
          </html>
        `);
        server.close();
        resolve(tokenData);
      } catch (err) {
        res.send(`<html><body><h1>Authentication Failed</h1><p>${err}</p></body></html>`);
        server.close();
        reject(err);
      }
    });

    server = app.listen(8888, () => {
      const authUrl = buildAuthUrl(config.clientId, codeChallenge, state);
      console.log('\nOpening browser for Spotify authentication...');
      console.log(`If the browser doesn't open, visit: ${authUrl}\n`);
      open(authUrl).catch(() => {
        // If open fails, user can manually visit the URL
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out'));
    }, 5 * 60 * 1000);
  });
}

function buildAuthUrl(clientId: string, codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
    scope: SCOPES,
  });

  return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  clientId: string
): Promise<TokenData> {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string
): Promise<TokenData> {
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
}
