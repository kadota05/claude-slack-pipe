// src/streaming/group-tracker.ts
import {
  buildThinkingLiveBlocks,
  buildToolGroupLiveBlocks,
  buildSubagentLiveBlocks,
  buildBundleCollapsedBlocks,
  getToolOneLiner,
} from './tool-formatter.js';
import type {
  BundleAction,
  GroupCategory,
  ActiveGroup,
  CompletedGroup,
  Block,
} from './types.js';

const DEBOUNCE_MS = 500;

interface ActiveBundle {
  id: string;
  index: number;
  messageTs: string | null;
  completedGroups: CompletedGroup[];
}

export class GroupTracker {
  private activeBundle: ActiveBundle | null = null;
  private activeGroup: ActiveGroup | null = null;
  private bundleCounter = 0;

  handleThinking(text: string): BundleAction[] {
    const actions: BundleAction[] = [];

    // Ensure bundle exists
    const isNewBundle = this.ensureBundle(actions);

    // Switch category if needed
    if (this.activeGroup && this.activeGroup.category !== 'thinking') {
      this.moveActiveGroupToCompleted();
      this.activeGroup = null;
    }

    if (!this.activeGroup) {
      this.activeGroup = this.createActiveGroup('thinking');
      this.activeGroup.thinkingTexts.push(text);

      if (isNewBundle) {
        // postMessage already added by ensureBundle with placeholder blocks;
        // update blocks now
        const postAction = actions.find(a => a.type === 'postMessage');
        if (postAction) {
          postAction.blocks = buildThinkingLiveBlocks(this.activeGroup.thinkingTexts);
          postAction.text = '思考中...';
        }
      } else if (this.activeBundle!.messageTs) {
        // Bundle exists, just switched category — update message
        actions.push(this.buildUpdateAction(
          buildThinkingLiveBlocks(this.activeGroup.thinkingTexts),
          '思考中...',
        ));
      }
    } else {
      this.activeGroup.thinkingTexts.push(text);

      if (this.activeBundle!.messageTs && this.shouldEmitUpdate()) {
        this.activeGroup.lastUpdateTime = Date.now();
        actions.push(this.buildUpdateAction(
          buildThinkingLiveBlocks(this.activeGroup.thinkingTexts),
          '思考中...',
        ));
      }
    }

    return actions;
  }

  handleToolUse(toolUseId: string, toolName: string, input: Record<string, unknown>): BundleAction[] {
    const actions: BundleAction[] = [];
    const oneLiner = getToolOneLiner(toolName, input);

    // Ensure bundle exists
    const isNewBundle = this.ensureBundle(actions);

    // Switch category if needed
    if (this.activeGroup && this.activeGroup.category !== 'tool') {
      this.moveActiveGroupToCompleted();
      this.activeGroup = null;
    }

    if (!this.activeGroup) {
      this.activeGroup = this.createActiveGroup('tool');
      this.activeGroup.tools.push({ toolUseId, toolName, input, oneLiner, status: 'running', startTime: Date.now() });

      if (isNewBundle) {
        const postAction = actions.find(a => a.type === 'postMessage');
        if (postAction) {
          postAction.blocks = buildToolGroupLiveBlocks(this.activeGroup.tools);
          postAction.text = `${toolName}: ${oneLiner}`;
        }
      } else if (this.activeBundle!.messageTs) {
        actions.push(this.buildUpdateAction(
          buildToolGroupLiveBlocks(this.activeGroup.tools),
          `${toolName}: ${oneLiner}`,
        ));
      }
    } else {
      this.activeGroup.tools.push({ toolUseId, toolName, input, oneLiner, status: 'running', startTime: Date.now() });

      if (this.activeBundle!.messageTs && this.shouldEmitUpdate()) {
        this.activeGroup.lastUpdateTime = Date.now();
        actions.push(this.buildUpdateAction(
          buildToolGroupLiveBlocks(this.activeGroup.tools),
          `${this.activeGroup.tools.length}ツール実行中`,
        ));
      }
    }

    return actions;
  }

  handleToolResult(toolUseId: string, result: string, isError: boolean): BundleAction[] {
    const actions: BundleAction[] = [];

    if (!this.activeGroup || this.activeGroup.category !== 'tool') return actions;

    const tool = this.activeGroup.tools.find(t => t.toolUseId === toolUseId);
    if (!tool) return actions;

    tool.status = isError ? 'error' : 'completed';
    tool.durationMs = Date.now() - tool.startTime;
    tool.result = result;
    tool.isError = isError;

    if (this.activeBundle?.messageTs && this.shouldEmitUpdate()) {
      this.activeGroup.lastUpdateTime = Date.now();
      actions.push(this.buildUpdateAction(
        buildToolGroupLiveBlocks(this.activeGroup.tools),
        `${this.activeGroup.tools.length}ツール実行中`,
      ));
    }

    return actions;
  }

  handleSubagentStart(toolUseId: string, description: string): BundleAction[] {
    const actions: BundleAction[] = [];

    const isNewBundle = this.ensureBundle(actions);

    // Switch category — move active group to completed
    if (this.activeGroup) {
      this.moveActiveGroupToCompleted();
      this.activeGroup = null;
    }

    this.activeGroup = this.createActiveGroup('subagent');
    this.activeGroup.agentToolUseId = toolUseId;
    this.activeGroup.agentDescription = description;

    if (isNewBundle) {
      const postAction = actions.find(a => a.type === 'postMessage');
      if (postAction) {
        postAction.blocks = buildSubagentLiveBlocks(description, []);
        postAction.text = `SubAgent: ${description}`;
      }
    } else if (this.activeBundle!.messageTs) {
      actions.push(this.buildUpdateAction(
        buildSubagentLiveBlocks(description, []),
        `SubAgent: ${description}`,
      ));
    }

    return actions;
  }

  handleSubagentStep(agentToolUseId: string, toolName: string, toolUseId: string, oneLiner: string): BundleAction[] {
    const actions: BundleAction[] = [];

    if (!this.activeGroup || this.activeGroup.category !== 'subagent') return actions;
    if (this.activeGroup.agentToolUseId !== agentToolUseId) return actions;

    this.activeGroup.agentSteps.push({ toolName, toolUseId, oneLiner, status: 'running' });

    if (this.activeBundle?.messageTs && this.shouldEmitUpdate()) {
      this.activeGroup.lastUpdateTime = Date.now();
      actions.push(this.buildUpdateAction(
        buildSubagentLiveBlocks(this.activeGroup.agentDescription || '', this.activeGroup.agentSteps),
        `SubAgent: ${this.activeGroup.agentDescription}`,
      ));
    }

    return actions;
  }

  handleSubagentStepResult(agentToolUseId: string, toolUseId: string, isError: boolean): BundleAction[] {
    const actions: BundleAction[] = [];

    if (!this.activeGroup || this.activeGroup.category !== 'subagent') return actions;
    if (this.activeGroup.agentToolUseId !== agentToolUseId) return actions;

    const step = this.activeGroup.agentSteps.find(s => s.toolUseId === toolUseId);
    if (step) {
      step.status = isError ? 'error' : 'completed';
    }

    if (this.activeBundle?.messageTs && this.shouldEmitUpdate()) {
      this.activeGroup.lastUpdateTime = Date.now();
      actions.push(this.buildUpdateAction(
        buildSubagentLiveBlocks(this.activeGroup.agentDescription || '', this.activeGroup.agentSteps),
        `SubAgent: ${this.activeGroup.agentDescription}`,
      ));
    }

    return actions;
  }

  handleSubagentComplete(agentToolUseId: string, _result: string, _durationMs: number): BundleAction[] {
    if (!this.activeGroup || this.activeGroup.category !== 'subagent') return [];
    if (this.activeGroup.agentToolUseId !== agentToolUseId) return [];

    // Move subagent group to completed, but do NOT collapse the bundle
    this.moveActiveGroupToCompleted();
    this.activeGroup = null;

    return [];
  }

  handleTextStart(sessionId: string): BundleAction[] {
    if (!this.activeBundle) return [];

    // Move active group to completed
    if (this.activeGroup) {
      this.moveActiveGroupToCompleted();
      this.activeGroup = null;
    }

    return this.collapseActiveBundle(sessionId);
  }

  flushActiveBundle(sessionId: string): BundleAction[] {
    if (!this.activeBundle) return [];

    // Mark running items as error
    if (this.activeGroup) {
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
      this.moveActiveGroupToCompleted();
      this.activeGroup = null;
    }

    return this.collapseActiveBundle(sessionId);
  }

  registerBundleMessageTs(bundleId: string, messageTs: string): void {
    if (this.activeBundle && this.activeBundle.id === bundleId) {
      this.activeBundle.messageTs = messageTs;
    }
  }

  setAgentId(agentId: string): void {
    if (this.activeGroup) {
      this.activeGroup.agentId = agentId;
    }
  }

  getActiveGroupData(): ActiveGroup | null {
    return this.activeGroup;
  }

  // --- Private helpers ---

  private ensureBundle(actions: BundleAction[]): boolean {
    if (this.activeBundle) return false;

    this.bundleCounter++;
    this.activeBundle = {
      id: `bundle-${this.bundleCounter}`,
      index: this.bundleCounter - 1,
      messageTs: null,
      completedGroups: [],
    };

    actions.push({
      type: 'postMessage',
      bundleId: this.activeBundle.id,
      bundleIndex: this.activeBundle.index,
      blocks: [], // will be filled by caller
      text: '',
    });

    return true;
  }

  private createActiveGroup(category: GroupCategory): ActiveGroup {
    return {
      id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      category,
      messageTs: null,
      startTime: Date.now(),
      lastUpdateTime: 0,
      thinkingTexts: [],
      tools: [],
      agentSteps: [],
    };
  }

  private moveActiveGroupToCompleted(): void {
    if (!this.activeGroup || !this.activeBundle) return;

    const cg: CompletedGroup = {
      category: this.activeGroup.category,
    };

    if (this.activeGroup.category === 'thinking') {
      cg.thinkingTexts = [...this.activeGroup.thinkingTexts];
    } else if (this.activeGroup.category === 'tool') {
      cg.tools = [...this.activeGroup.tools];
      cg.totalDuration = this.activeGroup.tools.reduce((sum, t) => sum + (t.durationMs || 0), 0);
    } else if (this.activeGroup.category === 'subagent') {
      cg.agentDescription = this.activeGroup.agentDescription;
      cg.agentId = this.activeGroup.agentId;
      cg.agentSteps = [...this.activeGroup.agentSteps];
      cg.duration = Date.now() - this.activeGroup.startTime;
    }

    this.activeBundle.completedGroups.push(cg);
  }

  private collapseActiveBundle(sessionId: string): BundleAction[] {
    const bundle = this.activeBundle;
    if (!bundle) return [];

    // Count categories
    let thinkingCount = 0, toolCount = 0, toolDurationMs = 0, subagentCount = 0, subagentDurationMs = 0;
    for (const cg of bundle.completedGroups) {
      if (cg.category === 'thinking') thinkingCount++;
      else if (cg.category === 'tool') {
        toolCount += cg.tools?.length || 0;
        toolDurationMs += cg.totalDuration || 0;
      }
      else if (cg.category === 'subagent') {
        subagentCount++;
        subagentDurationMs += cg.duration || 0;
      }
    }

    const blocks = buildBundleCollapsedBlocks({
      thinkingCount,
      toolCount,
      toolDurationMs,
      subagentCount,
      subagentDurationMs,
      sessionId,
      bundleIndex: bundle.index,
    });

    const actions: BundleAction[] = [];

    if (bundle.messageTs) {
      actions.push({
        type: 'collapse',
        bundleId: bundle.id,
        bundleIndex: bundle.index,
        messageTs: bundle.messageTs,
        blocks,
        text: 'bundle collapsed',
        sessionId,
      });
    }

    // Reset bundle
    this.activeBundle = null;

    return actions;
  }

  private buildUpdateAction(blocks: Block[], text: string): BundleAction {
    return {
      type: 'update',
      bundleId: this.activeBundle!.id,
      bundleIndex: this.activeBundle!.index,
      messageTs: this.activeBundle!.messageTs!,
      blocks,
      text,
    };
  }

  private shouldEmitUpdate(): boolean {
    if (!this.activeGroup) return false;
    return Date.now() - this.activeGroup.lastUpdateTime >= DEBOUNCE_MS;
  }
}
