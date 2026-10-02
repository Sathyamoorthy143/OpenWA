import { Module } from '@nestjs/common';
import { MessageModule } from '../message/message.module';
import { ChatbotController } from './chatbot.controller';

@Module({
  imports: [MessageModule],
  controllers: [ChatbotController],
})
export class ChatbotModule {}
