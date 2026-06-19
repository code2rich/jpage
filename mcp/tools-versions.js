// MCP 版本类工具：list_file_versions / restore_file_version。
// 从 mcp-server.js 提取，行为保持不变。

const { z } = require('zod');
const { textResult, formatSize, formatTime } = require('./util');

function registerVersionTools(server, { api }) {
  // --- list_file_versions ---
  server.registerTool(
    'list_file_versions',
    {
      title: 'List File Versions',
      description: '列出指定文件的版本历史，包括当前版本信息。适用于查看文件修改历史、确认版本数量、或决定是否恢复到某个历史版本。',
      inputSchema: {
        fileId: z.number().positive().describe('文件 ID'),
      },
    },
    async ({ fileId }) => {
      const data = await api.get(`/api/files/${fileId}/versions`);
      const current = data.current;
      const versions = data.versions || [];
      const currentSize = formatSize(current.size);
      const updatedAt = formatTime(current.updated_at);
      const lines = [`文件 #${fileId} 版本历史（共 ${versions.length} 个历史版本）：`];
      lines.push(`当前版本: ${currentSize}, 更新于 ${updatedAt}`);
      for (const v of versions) {
        const vSize = formatSize(v.size);
        const vTime = formatTime(v.created_at);
        lines.push(`v${v.version}: ${vSize}, ${vTime}  [查看 | 恢复 | 删除]`);
      }
      return textResult(lines.join('\n'));
    }
  );

  // --- restore_file_version ---
  server.registerTool(
    'restore_file_version',
    {
      title: 'Restore File Version',
      description: '恢复指定文件到某个历史版本。恢复后当前版本会被保存为新的历史版本，目标历史版本的内容成为新的当前版本。适用于撤销误修改或回退到之前的版本。',
      inputSchema: {
        fileId: z.number().positive().describe('文件 ID'),
        version: z.number().positive().describe('要恢复的版本号'),
      },
    },
    async ({ fileId, version }) => {
      const data = await api.post(`/api/files/${fileId}/versions/${version}/restore`);
      return textResult({
        fileId,
        restoredVersion: version,
        ...data,
      });
    }
  );
}

module.exports = { registerVersionTools };
