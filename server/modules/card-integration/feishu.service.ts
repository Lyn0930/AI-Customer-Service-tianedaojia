import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';

function loadLocalEnvFile(): void {
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    return;
  }
  const candidates = ['.env.local', '.env'];
  for (const name of candidates) {
    const filePath = path.resolve(process.cwd(), name);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*(FEISHU_APP_ID|FEISHU_APP_SECRET)\s*=\s*(.+?)\s*$/u);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
    if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
      return;
    }
  }
}

loadLocalEnvFile();

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  throw new Error(
    'FEISHU_APP_ID / FEISHU_APP_SECRET 未配置；本地放 .env/.env.local，妙搭请在控制台配置环境变量',
  );
}

@Injectable()
export class FeishuService {
  private readonly logger = new Logger(FeishuService.name);
  private readonly client: lark.Client;

  constructor() {
    this.client = new lark.Client({
      appId: FEISHU_APP_ID,
      appSecret: FEISHU_APP_SECRET,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });
  }

  async sendInteractiveCard(
    openId: string,
    cardTemplate: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          content: JSON.stringify(cardTemplate),
          msg_type: 'interactive',
        },
      });

      if (res.code !== 0) {
        this.logger.error(
          `Feishu API error [${res.code}]: ${res.msg}`,
        );
        return null;
      }

      const messageId = res.data?.message_id ?? null;
      this.logger.log(`Card sent to ${openId}, messageId=${messageId}`);
      return messageId;
    } catch (error) {
      this.logger.error(`Failed to send card: ${String(error)}`);
      return null;
    }
  }

  async sendTextMessage(openId: string, text: string): Promise<boolean> {
    try {
      const res = await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });

      if (res.code !== 0) {
        this.logger.error(
          `Feishu API error [${res.code}]: ${res.msg}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Failed to send text: ${String(error)}`);
      return false;
    }
  }
}
