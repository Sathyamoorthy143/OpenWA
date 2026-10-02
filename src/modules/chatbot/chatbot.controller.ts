import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { MessageService } from '../message/message.service';
import { Public } from '../auth/decorators/auth.decorators';
import { createLogger } from '../../common/services/logger.service';

interface ChatbotWebhookData {
  from?: string;
  body?: string;
  fromMe?: boolean;
  isGroup?: boolean;
}

interface ChatbotWebhookPayload {
  event?: string;
  sessionId?: string;
  data?: ChatbotWebhookData;
}

function replyFor(incomingText: string): string {
  const text = (incomingText || '').trim().toLowerCase();
  if (text === 'hello' || text === 'hi') {
    return "Hi there! How's it going?";
  }
  if (text === 'help') {
    return "Here are the things I can do:\n1. Type 'hi'\n2. Type 'status'";
  }
  if (text === 'status') {
    return 'Bot is online and listening for messages.';
  }
  return 'Hello! I received your message. How can I help you today?';
}

@ApiTags('chatbot')
@Controller('chatbot')
export class ChatbotController {
  private readonly logger = createLogger('Chatbot');

  constructor(private readonly messageService: MessageService) {}

  @Post('webhook')
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Embedded chatbot webhook (no separate server needed)' })
  async handleWebhook(@Body() payload: ChatbotWebhookPayload): Promise<{ ok: boolean }> {
    try {
      if (!payload || payload.event !== 'message.received' || !payload.data) {
        return { ok: true };
      }
      const sessionId = payload.sessionId;
      const senderId = payload.data.from;
      const incomingText = payload.data.body ?? '';
      const isGroup = payload.data.isGroup ?? false;
      const fromMe = payload.data.fromMe ?? false;

      // Ignore our own messages and group chats to avoid loops, same as the sample server.
      if (fromMe || isGroup) {
        return { ok: true };
      }
      if (!sessionId || !senderId) {
        return { ok: true };
      }

      this.logger.log(`Received message from ${senderId}: "${incomingText}"`);
      const replyText = replyFor(incomingText);
      await this.messageService.sendText(sessionId, { chatId: senderId, text: replyText });
      this.logger.log(`Replied to ${senderId}`);
    } catch (err) {
      // Never fail the webhook delivery: log and ack so OpenWA does not retry in a loop.
      this.logger.error(`Chatbot reply failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true };
  }
}
