import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const BLOG_TRIGGER = /^@blog\b/i;

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Fetch channel/thread context intelligently.
   * Starts with 15 messages; if the conversation looks incomplete,
   * fetches up to 50.
   */
  private async fetchChannelContext(message: Message): Promise<NewMessage[]> {
    const chatJid = `dc:${message.channelId}`;

    let fetched: Collection<string, Message>;
    try {
      fetched = await message.channel.messages.fetch({
        limit: 15,
        before: message.id,
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Discord channel context');
      return [];
    }

    let sorted = [...fetched.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp,
    );

    // Heuristics: does the conversation look incomplete?
    if (sorted.length > 0) {
      const firstMsg = sorted[0];
      const lastMsg = sorted[sorted.length - 1];
      const timeSpanMs = lastMsg.createdTimestamp - firstMsg.createdTimestamp;
      const hasReplyAtStart = firstMsg.reference != null;
      // Dense conversation: all 15 messages fit within 10 minutes
      const isDenseConversation =
        timeSpanMs < 10 * 60 * 1000 && sorted.length >= 14;

      if (hasReplyAtStart || isDenseConversation) {
        try {
          fetched = await message.channel.messages.fetch({
            limit: 50,
            before: message.id,
          });
          sorted = [...fetched.values()].sort(
            (a, b) => a.createdTimestamp - b.createdTimestamp,
          );
        } catch {
          // Keep the original 15 if the extended fetch fails
        }
      }
    }

    logger.info(
      { count: sorted.length, channelId: message.channelId },
      'Fetched Discord channel context for @Blog',
    );

    // Convert to NewMessage format, filtering out bot messages
    return sorted
      .filter((m) => !m.author.bot)
      .map((m) => ({
        id: m.id,
        chat_jid: chatJid,
        sender: m.author.id,
        sender_name:
          m.member?.displayName || m.author.displayName || m.author.username,
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        is_from_me: false,
      }));
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> -- these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Catch-all @Blog trigger: works in ANY Discord channel.
      // Uses a virtual JID (dc-blog:{channelId}) so blog messages don't
      // trigger the regular group agent listening on the same channel.
      const isBlogTrigger = BLOG_TRIGGER.test(content.trim());

      if (isBlogTrigger) {
        const blogJid = `dc-blog:${channelId}`;

        // Auto-register blog virtual JID if not already registered
        const groups = this.opts.registeredGroups();
        if (!groups[blogJid] && this.opts.onRegisterGroup) {
          this.opts.onRegisterGroup(blogJid, {
            name: `Blog (${chatName})`,
            folder: 'blog',
            trigger: '@blog',
            added_at: new Date().toISOString(),
            requiresTrigger: true,
            containerConfig: {
              additionalMounts: [
                { hostPath: '~/code/procedural', readonly: false },
              ],
            },
          });
        }

        // Fetch thread/channel context and inject as stored messages
        const contextMessages = await this.fetchChannelContext(message);
        for (const msg of contextMessages) {
          // Store context under the blog virtual JID
          this.opts.onMessage(blogJid, { ...msg, chat_jid: blogJid });
        }

        // Rewrite @Blog to @Andy and store under blog JID
        const blogContent = content.replace(BLOG_TRIGGER, `@${ASSISTANT_NAME}`);
        this.opts.onMessage(blogJid, {
          id: msgId,
          chat_jid: blogJid,
          sender,
          sender_name: senderName,
          content: blogContent,
          timestamp,
          is_from_me: false,
        });

        // Store chat metadata for the blog virtual JID
        this.opts.onChatMetadata(
          blogJid,
          timestamp,
          chatName,
          'discord',
          message.guild !== null,
        );

        logger.info(
          { blogJid, chatName, contextCount: contextMessages.length },
          '@Blog trigger detected, context injected',
        );

        // Don't fall through to store as regular message -- return early
        // so the regular group agent doesn't see this message at all.
        return;
      }

      // Handle attachments -- store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context -- include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // For non-blog triggers, only deliver to registered groups.
      // Blog triggers auto-register above, so they pass this check.
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message -- startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  /**
   * Extract the real Discord channel ID from a JID.
   * Handles both regular (dc:123) and virtual (dc-blog:123) JIDs.
   */
  private extractChannelId(jid: string): string {
    return jid.replace(/^dc(?:-blog)?:/, '');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = this.extractChannelId(jid);
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message -- split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:') || jid.startsWith('dc-blog:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = this.extractChannelId(jid);
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
