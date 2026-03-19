// src/streaming/group-tracker.ts
import { createHash } from 'node:crypto';
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
import { notifyText } from './notification-text.js';

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
  private activeSubagents: Map<string, ActiveGroup> = new Map();
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
          postAction.text = notifyText.update.thinking();
        }
      } else if (this.activeBundle!.messageTs) {
        // Bundle exists, just switched category — update message
        actions.push(this.buildUpdateAction(
          buildThinkingLiveBlocks(this.activeGroup.thinkingTexts),
          notifyText.update.thinking(),
        ));
      }
    } else {
      this.activeGroup.thinkingTexts.push(text);

      if (this.activeBundle!.messageTs && this.shouldEmitUpdate()) {
        this.activeGroup.lastUpdateTime = Date.now();
        actions.push(this.buildUpdateAction(
          buildThinkingLiveBlocks(this.activeGroup.thinkingTexts),
          notifyText.update.thinking(),
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
          notifyText.update.tools(this.activeGroup.tools),
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
        notifyText.update.tools(this.activeGroup.tools),
      ));
    }

    return actions;
  }

  handleSubagentStart(toolUseId: string, description: string): BundleAction[] {
    const actions: BundleAction[] = [];

    const isNewBundle = this.ensureBundle(actions);

    // Move active group (thinking/tool) to completed if present
    if (this.activeGroup) {
      this.moveActiveGroupToCompleted();
      this.activeGroup = null;
    }

    // Store in Map instead of activeGroup
    const group = this.createActiveGroup('subagent');
    group.agentToolUseId = toolUseId;
    group.agentDescription = description;
    this.activeSubagents.set(toolUseId, group);

    if (isNewBundle) {
      const postAction = actions.find(a => a.type === 'postMessage');
      if (postAction) {
        postAction.blocks = this.buildLiveBundleBlocks();
        postAction.text = `SubAgent: ${description}`;
      }
    } else if (this.activeBundle!.messageTs) {
      actions.push(this.buildUpdateAction(
        this.buildLiveBundleBlocks(),
        `SubAgent: ${description}`,
      ));
    }

    return actions;
  }

  handleSubagentStep(agentToolUseId: string, toolName: string, toolUseId: string, oneLiner: string): BundleAction[] {
    const actions: BundleAction[] = [];

    const agent = this.activeSubagents.get(agentToolUseId);
    if (!agent) return actions;

    agent.agentSteps.push({ toolName, toolUseId, oneLiner, status: 'running' });

    if (this.activeBundle?.messageTs && this.shouldEmitUpdateForGroup(agent)) {
      agent.lastUpdateTime = Date.now();
      actions.push(this.buildUpdateAction(
        this.buildLiveBundleBlocks(),
        `SubAgent: ${agent.agentDescription}`,
      ));
    }

    return actions;
  }

  handleSubagentStepResult(agentToolUseId: string, toolUseId: string, isError: boolean): BundleAction[] {
    const actions: BundleAction[] = [];

    const agent = this.activeSubagents.get(agentToolUseId);
    if (!agent) return actions;

    const step = agent.agentSteps.find(s => s.toolUseId === toolUseId);
    if (step) {
      step.status = isError ? 'error' : 'completed';
    }

    if (this.activeBundle?.messageTs && this.shouldEmitUpdateForGroup(agent)) {
      agent.lastUpdateTime = Date.now();
      actions.push(this.buildUpdateAction(
        this.buildLiveBundleBlocks(),
        `SubAgent: ${agent.agentDescription}`,
      ));
    }

    return actions;
  }

  handleSubagentComplete(agentToolUseId: string, _result: string, _durationMs: number): BundleAction[] {
    const agent = this.activeSubagents.get(agentToolUseId);
    if (!agent) return [];

    // Move to completedGroups and remove from Map
    const cg: CompletedGroup = {
      category: 'subagent',
      agentDescription: agent.agentDescription,
      agentId: agent.agentId,
      agentSteps: [...agent.agentSteps],
      duration: Date.now() - agent.startTime,
    };
    this.activeBundle!.completedGroups.push(cg);
    this.activeSubagents.delete(agentToolUseId);

    return [];
  }

  handleTextStart(sessionId: string): BundleAction[] {
    if (!this.activeBundle) return [];

    // Do not collapse while subagents are still running
    if (this.activeSubagents.size > 0) return [];

    // Move active group to completed
    if (this.activeGroup) {
      this.moveActiveGroupToCompleted();
      this.activeGroup = null;
    }

    return this.collapseActiveBundle(sessionId);
  }

  flushActiveBundle(sessionId: string): BundleAction[] {
    if (!this.activeBundle) return [];

    // Mark running items as error in activeGroup
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

    // Mark running items as error in activeSubagents and move to completed
    for (const [, agent] of this.activeSubagents) {
      for (const step of agent.agentSteps) {
        if (step.status === 'running') step.status = 'error';
      }
      const cg: CompletedGroup = {
        category: 'subagent',
        agentDescription: agent.agentDescription,
        agentId: agent.agentId,
        agentSteps: [...agent.agentSteps],
        duration: Date.now() - agent.startTime,
      };
      this.activeBundle!.completedGroups.push(cg);
    }
    this.activeSubagents.clear();

    return this.collapseActiveBundle(sessionId);
  }

  registerBundleMessageTs(bundleId: string, messageTs: string): void {
    if (this.activeBundle && this.activeBundle.id === bundleId) {
      this.activeBundle.messageTs = messageTs;
    }
  }

  setAgentId(agentId: string, agentToolUseId?: string): void {
    if (agentToolUseId) {
      const agent = this.activeSubagents.get(agentToolUseId);
      if (agent) {
        agent.agentId = agentId;
        return;
      }
    }
    if (this.activeGroup) {
      this.activeGroup.agentId = agentId;
    }
  }

  getActiveGroupData(): ActiveGroup | null {
    return this.activeGroup;
  }

  getActiveSubagent(toolUseId: string): ActiveGroup | undefined {
    return this.activeSubagents.get(toolUseId);
  }

  hasActiveSubagents(): boolean {
    return this.activeSubagents.size > 0;
  }

  canCollapse(): boolean {
    return this.activeSubagents.size === 0;
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
      text: notifyText.update.pending(),
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

  private extractBundleKey(completedGroups: CompletedGroup[]): string {
    // Try first tool_use_id from tool groups
    for (const cg of completedGroups) {
      if (cg.category === 'tool' && cg.tools && cg.tools.length > 0) {
        return cg.tools[0].toolUseId;
      }
      if (cg.category === 'subagent' && cg.agentSteps && cg.agentSteps.length > 0) {
        return cg.agentSteps[0].toolUseId;
      }
    }

    // Fallback: hash of first thinking text
    for (const cg of completedGroups) {
      if (cg.category === 'thinking' && cg.thinkingTexts && cg.thinkingTexts.length > 0) {
        const hash = createHash('sha256').update(cg.thinkingTexts[0]).digest('hex').slice(0, 12);
        return `th_${hash}`;
      }
    }

    // Last resort
    return `fallback_${Date.now()}`;
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

    const bundleKey = this.extractBundleKey(bundle.completedGroups);

    const blocks = buildBundleCollapsedBlocks({
      thinkingCount,
      toolCount,
      toolDurationMs,
      subagentCount,
      subagentDurationMs,
      sessionId,
      bundleIndex: bundle.index,
      bundleKey,
    });

    const actions: BundleAction[] = [];

    if (bundle.messageTs) {
      actions.push({
        type: 'collapse',
        bundleId: bundle.id,
        bundleIndex: bundle.index,
        bundleKey,
        messageTs: bundle.messageTs,
        blocks,
        text: notifyText.update.collapsed({
          thinkingCount,
          toolCount,
          toolDurationMs,
          subagentCount,
          subagentDurationMs,
        }),
        sessionId,
      });
    }

    // Reset bundle
    this.activeBundle = null;

    return actions;
  }

  private buildLiveBundleBlocks(): Block[] {
    const blocks: Block[] = [];

    // Completed groups first
    for (const cg of this.activeBundle!.completedGroups) {
      blocks.push(...this.buildCompletedGroupBlocks(cg));
    }

    // Active group (thinking/tool)
    if (this.activeGroup) {
      if (this.activeGroup.category === 'thinking') {
        blocks.push(...buildThinkingLiveBlocks(this.activeGroup.thinkingTexts));
      } else if (this.activeGroup.category === 'tool') {
        blocks.push(...buildToolGroupLiveBlocks(this.activeGroup.tools));
      }
    }

    // All active subagents
    for (const [, agent] of this.activeSubagents) {
      blocks.push(...buildSubagentLiveBlocks(agent.agentDescription || '', agent.agentSteps));
    }

    return blocks;
  }

  private buildCompletedGroupBlocks(cg: CompletedGroup): Block[] {
    if (cg.category === 'thinking' && cg.thinkingTexts) {
      return buildThinkingLiveBlocks(cg.thinkingTexts);
    } else if (cg.category === 'tool' && cg.tools) {
      return buildToolGroupLiveBlocks(cg.tools);
    } else if (cg.category === 'subagent') {
      return buildSubagentLiveBlocks(cg.agentDescription || '', cg.agentSteps || []);
    }
    return [];
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
    return this.shouldEmitUpdateForGroup(this.activeGroup);
  }

  private shouldEmitUpdateForGroup(group: ActiveGroup): boolean {
    return Date.now() - group.lastUpdateTime >= DEBOUNCE_MS;
  }
}
