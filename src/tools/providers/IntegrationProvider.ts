// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

import type { IToolProvider, ToolExecutionContext } from './IToolProvider';

const TOOLS = new Set([
  'whatsapp_connect','whatsapp_status','whatsapp_disconnect',
  'whatsapp_save_credentials','whatsapp_send','whatsapp_send_template',
]);

/** WhatsApp 所有工具均委派至 callbacks.handleWhatsAppTool，本 Provider 是純路由層。 */
export class IntegrationProvider implements IToolProvider {
  readonly tools: ReadonlySet<string> = TOOLS;

  execute(name: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
    if (!ctx.handleWhatsApp) return Promise.resolve(`IntegrationProvider: handleWhatsApp 未注入 (tool: ${name})`);
    return ctx.handleWhatsApp(name, args);
  }
}
