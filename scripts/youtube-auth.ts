/**
 * One-time consent flow that prints a YOUTUBE_REFRESH_TOKEN for .env.
 *
 * Prerequisites in Google Cloud Console:
 *   1. Enable "YouTube Data API v3".
 *   2. Create an OAuth client of type "Web application".
 *   3. Add http://localhost:8787/oauth2callback as an authorized redirect URI.
 *   4. While the app is in Testing, add your Google account as a test user.
 *
 * Run with: npm run youtube:auth
 */
import http from 'node:http';
import { URL } from 'node:url';
import { createOAuthClient, REDIRECT_URI, YOUTUBE_SCOPES } from '../src/youtube/auth.js';

const client = createOAuthClient();
const port = Number(new URL(REDIRECT_URI).port || 80);

const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  scope: YOUTUBE_SCOPES,
  // Google only returns a refresh token on the first consent unless it is forced.
  prompt: 'consent',
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', REDIRECT_URI);
  if (url.pathname !== new URL(REDIRECT_URI).pathname) {
    res.writeHead(404).end('not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    res.writeHead(400).end(`Authorization failed: ${error ?? 'no code returned'}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  client
    .getToken(code)
    .then(({ tokens }) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('Done. You can close this tab.');
      server.close();

      if (!tokens.refresh_token) {
        console.error(
          '\nNo refresh token returned. Revoke the app at https://myaccount.google.com/permissions and run this again.',
        );
        process.exitCode = 1;
        return;
      }

      console.log('\nAdd this to your .env:\n');
      console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    })
    .catch((err: Error) => {
      res.writeHead(500).end(err.message);
      server.close();
      process.exitCode = 1;
    });
});

server.listen(port, () => {
  console.log(`Listening on ${REDIRECT_URI}\n`);
  console.log('Open this URL and grant access:\n');
  console.log(`${authUrl}\n`);
});
