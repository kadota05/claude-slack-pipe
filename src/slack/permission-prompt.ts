// src/slack/permission-prompt.ts
export function buildPermissionPromptBlocks(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}): any[] {
  const inputPreview = JSON.stringify(params.toolInput).slice(0, 200);
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `🔧 *${params.toolName}* を実行しようとしています\n> \`${inputPreview}\`` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve' },
          action_id: 'permission_approve',
          value: `approve:${params.toolUseId}`,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Deny' },
          action_id: 'permission_deny',
          value: `deny:${params.toolUseId}`,
          style: 'danger',
        },
      ],
    },
  ];
}

export function parsePermissionAction(value: string): { toolUseId: string; allowed: boolean } {
  const [action, toolUseId] = value.split(':');
  return { toolUseId, allowed: action === 'approve' };
}
