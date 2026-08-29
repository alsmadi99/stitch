import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  // Not used for uploading — it lets `npm run doctor` name the account the token
  // belongs to, which is the difference between "no channel" and "wrong account".
  'https://www.googleapis.com/auth/userinfo.email',
];

/** Redirect URI registered on the OAuth client; the auth script listens on this port. */
export const REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:8787/oauth2callback';

export function createOAuthClient(): OAuth2Client {
  if (!config.youtube.clientId || !config.youtube.clientSecret) {
    throw new Error('YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set');
  }
  return new google.auth.OAuth2(config.youtube.clientId, config.youtube.clientSecret, REDIRECT_URI);
}

export function authorizedClient(): OAuth2Client {
  if (!config.youtube.refreshToken) {
    throw new Error('YOUTUBE_REFRESH_TOKEN is missing — run `npm run youtube:auth`');
  }
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: config.youtube.refreshToken });
  return client;
}

export function youtubeClient() {
  return google.youtube({ version: 'v3', auth: authorizedClient() });
}
