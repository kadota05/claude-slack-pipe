// src/streaming/group-tracker.ts
import {
  buildThinkingLiveBlocks,
  buildThinkingCollapsedBlocks,
  buildToolGroupLiveBlocks,
  buildToolGroupCollapsedBlocks,
  buildSubagentLiveBlocks,
  buildSubagentCollapsedBlocks,
  getToolOneLiner,
} from './tool-formatter.js';
import type {
  GroupAction,
  GroupCategory,
  ActiveGroup,
  Block,
} from './types.js';

const DEBOUNCE_MS = 500;

export class GroupTracker {
  private activeGroup: ActiveGroup | null = null;
  private completedGroups: Map<string, ActiveGroup> = new Map();
  private groupCounter = 0;

  handleThinking(text: string): GroupAction[] {
    const actions: GroupAction[] = [];

    if (this.activeGroup && this.activeGroup.category !== 'thinking') {
      actions.push(...this.collapseActiveGroup());
    }

    if (!this.activeGroup) {
      const group = this.createGroup('thinking');
      group.thinkingTexts.push(text);
      this.activeGroup = group;

      actions.push({
        type: 'postMessage',
        groupId: group.id,
        blocks: buildThinkingLiveBlocks(group.thinkingTexts),
        text: '思考中...',
        category: 'thinking',
      });
    } else {
      this.activeGroup.thinkingTexts.push(text);

      if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
        this.activeGroup.lastUpdateTime = Date.now();
        actions.push({
          type: 'update',
          groupId: this.activeGroup.id,
          messageTs: this.activeGroup.messageTs,
          blocks: buildThinkingLiveBlocks(this.activeGroup.thinkingTexts),
          text: '思考中...',
          category: 'thinking',
        });
      }
    }

    return actions;
  }

  handleToolUse(toolUseId: string, toolName: string, input: Record<string, unknown>): GroupAction[] {
    const actions: GroupAction[] = [];
    const oneLiner = getToolOneLiner(toolName, input);

    if (this.activeGroup && this.activeGroup.category !== 'tool') {
      actions.push(...this.collapseActiveGroup());
    }

    if (!this.activeGroup) {
      const group = this.createGroup('tool');
      group.tools.push({ toolUseId, toolName, input, oneLiner, status: 'running', startTime: Date.now() });
      this.activeGroup = group;

      actions.push({
        type: 'postMessage',
        groupId: group.id,
        blocks: buildToolGroupLiveBlocks(group.tools),
        text: `${toolName}: ${oneLiner}`,
        category: 'tool',
      });
    } else {
      this.activeGroup.tools.push({ toolUseId, toolName, input, oneLiner, status: 'running', startTime: Date.now() });

      if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
        this.activeGroup.lastUpdateTime = Date.now();
        actions.push({
          type: 'update',
          groupId: this.activeGroup.id,
          messageTs: this.activeGroup.messageTs,
          blocks: buildToolGroupLiveBlocks(this.activeGroup.tools),
          text: `${this.activeGroup.tools.length}ツール実行中`,
          category: 'tool',
        });
      }
    }

    return actions;
  }

  handleToolResult(toolUseId: string, result: string, isError: boolean): GroupAction[] {
    const actions: GroupAction[] = [];

    if (!this.activeGroup || this.activeGroup.category !== 'tool') return actions;

    const tool = this.activeGroup.tools.find(t => t.toolUseId === toolUseId);
    if (!tool) return actions;

    tool.status = isError ? 'error' : 'completed';
    tool.durationMs = Date.now() - tool.startTime;
    tool.result = result;
    tool.isError = isError;

    const allDone = this.activeGroup.tools.every(t => t.status !== 'running');

    if (allDone) {
      actions.push(...this.collapseActiveGroup());
    } else if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
      this.activeGroup.lastUpdateTime = Date.now();
      actions.push({
        type: 'update',
        groupId: this.activeGroup.id,
        messageTs: this.activeGroup.messageTs,
        blocks: buildToolGroupLiveBlocks(this.activeGroup.tools),
        text: `${this.activeGroup.tools.length}ツール実行中`,
        category: 'tool',
      });
    }

    return actions;
  }

  handleSubagentStart(toolUseId: string, description: string): GroupAction[] {
    const actions: GroupAction[] = [];

    if (this.activeGroup) {
      actions.push(...this.collapseActiveGroup());
    }

    const group = this.createGroup('subagent');
    group.agentToolUseId = toolUseId;
    group.agentDescription = description;
    this.activeGroup = group;

    actions.push({
      type: 'postMessage',
      groupId: group.id,
      blocks: buildSubagentLiveBlocks(description, []),
      text: `SubAgent: ${description}`,
      category: 'subagent',
    });

    return actions;
  }

  handleSubagentStep(agentToolUseId: string, toolName: string, toolUseId: string, oneLiner: string): GroupAction[] {
    const actions: GroupAction[] = [];

    if (!this.activeGroup || this.activeGroup.category !== 'subagent') return actions;
    if (this.activeGroup.agentToolUseId !== agentToolUseId) return actions;

    this.activeGroup.agentSteps.push({ toolName, toolUseId, oneLiner, status: 'running' });

    if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
      this.activeGroup.lastUpdateTime = Date.now();
      actions.push({
        type: 'update',
        groupId: this.activeGroup.id,
        messageTs: this.activeGroup.messageTs,
        blocks: buildSubagentLiveBlocks(this.activeGroup.agentDescription || '', this.activeGroup.agentSteps),
        text: `SubAgent: ${this.activeGroup.agentDescription}`,
        category: 'subagent',
      });
    }

    return actions;
  }

  handleSubagentStepResult(agentToolUseId: string, toolUseId: string, isError: boolean): GroupAction[] {
    const actions: GroupAction[] = [];

    if (!this.activeGroup || this.activeGroup.category !== 'subagent') return actions;
    if (this.activeGroup.agentToolUseId !== agentToolUseId) return actions;

    const step = this.activeGroup.agentSteps.find(s => s.toolUseId === toolUseId);
    if (step) {
      step.status = isError ? 'error' : 'completed';
    }

    if (this.activeGroup.messageTs && this.shouldEmitUpdate()) {
      this.activeGroup.lastUpdateTime = Date.now();
      actions.push({
        type: 'update',
        groupId: this.activeGroup.id,
        messageTs: this.activeGroup.messageTs,
        blocks: buildSubagentLiveBlocks(this.activeGroup.agentDescription || '', this.activeGroup.agentSteps),
        text: `SubAgent: ${this.activeGroup.agentDescription}`,
        category: 'subagent',
      });
    }

    return actions;
  }

  handleSubagentComplete(agentToolUseId: string, _result: string, _durationMs: number): GroupAction[] {
    if (!this.activeGroup || this.activeGroup.category !== 'subagent') return [];
    if (this.activeGroup.agentToolUseId !== agentToolUseId) return [];

    return this.collapseActiveGroup();
  }

  handleTextStart(): GroupAction[] {
    if (!this.activeGroup) return [];
    return this.collapseActiveGroup();
  }

  flushActiveGroup(): GroupAction[] {
    if (!this.activeGroup) return [];
    if (this.activeGroup.category === 'tool') {
      for (const tool of this.activeGroup.tools) {
        if (tool.status === 'running') tool.status = 'error';
      }
    }
    if (this.activeGroup.category === 'subagent') {
      for (const step of this.activeGroup.agentSteps) {
        if (step.status === 'running') step.status = 'error';
      }
    }
    return this.collapseActiveGroup();
  }

  registerMessageTs(groupId: string, messageTs: string): void {
    if (this.activeGroup && this.activeGroup.id === groupId) {
      this.activeGroup.messageTs = messageTs;
    }
  }

  setAgentId(groupId: string, agentId: string): void {
    if (this.activeGroup && this.activeGroup.id === groupId) {
      this.activeGroup.agentId = agentId;
    }
    const completed = this.completedGroups.get(groupId);
    if (completed) {
      completed.agentId = agentId;
    }
  }

  getGroupData(groupId: string): ActiveGroup | undefined {
    if (this.activeGroup && this.activeGroup.id === groupId) {
      return this.activeGroup;
    }
    return this.completedGroups.get(groupId);
  }

  private shouldEmitUpdate(): boolean {
    if (!this.activeGroup) return false;
    return Date.now() - this.activeGroup.lastUpdateTime >= DEBOUNCE_MS;
  }

  private collapseActiveGroup(): GroupAction[] {
    const group = this.activeGroup;
    if (!group) return [];

    this.activeGroup = null;
    this.completedGroups.set(group.id, group);

    if (!group.messageTs) return [];

    const blocks = this.buildCollapseBlocks(group);
    return [{
      type: 'collapse',
      groupId: group.id,
      messageTs: group.messageTs,
      blocks,
      text: this.buildCollapseText(group),
      category: group.category,
    }];
  }

  private buildCollapseBlocks(group: ActiveGroup): Block[] {
    switch (group.category) {
      case 'thinking':
        return buildThinkingCollapsedBlocks(group.thinkingTexts.length, group.id);
      case 'tool': {
        const counts = new Map<string, number>();
        for (const t of group.tools) {
          counts.set(t.toolName, (counts.get(t.toolName) || 0) + 1);
        }
        const toolSummaries = [...counts.entries()].map(([toolName, count]) => ({ toolName, count }));
        const totalDuration = group.tools.reduce((sum, t) => sum + (t.durationMs || 0), 0);
        return buildToolGroupCollapsedBlocks(toolSummaries, totalDuration, group.id);
      }
      case 'subagent': {
        const totalDuration = Date.now() - group.startTime;
        return buildSubagentCollapsedBlocks(group.agentDescription || 'SubAgent', totalDuration, group.id);
      }
    }
  }

  private buildCollapseText(group: ActiveGroup): string {
    switch (group.category) {
      case 'thinking': return '思考完了';
      case 'tool': return `${group.tools.length}ツール完了`;
      case 'subagent': return `SubAgent: ${group.agentDescription || ''} 完了`;
    }
  }

  private createGroup(category: GroupCategory): ActiveGroup {
    this.groupCounter++;
    return {
      id: `grp-${this.groupCounter}`,
      category,
      messageTs: null,
      startTime: Date.now(),
      lastUpdateTime: 0,
      thinkingTexts: [],
      tools: [],
      agentSteps: [],
    };
  }
}
