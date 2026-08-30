import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Privileged: enable "Message Content Intent" in the Developer Portal, otherwise
    // attachments and links arrive empty and nothing is ever collected.
    GatewayIntentBits.MessageContent,
    // Vetoing a clip by reacting to it needs this.
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Reaction and Message partials matter for backfilled clips: a reaction on a message
  // posted before the bot started arrives uncached, and without these it is dropped.
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.on('error', (err) => logger.error({ err: err.message }, 'discord client error'));
client.on('warn', (msg) => logger.warn({ msg }, 'discord warning'));

export async function login(): Promise<void> {
  await client.login(config.discord.token);
  await new Promise<void>((resolve) => {
    if (client.isReady()) return resolve();
    client.once(Events.ClientReady, () => resolve());
  });
  logger.info({ user: client.user?.tag }, 'discord connected');
}
