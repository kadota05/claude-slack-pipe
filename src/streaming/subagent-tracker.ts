// src/streaming/subagent-tracker.ts

export interface SubagentStep {
  toolName: string;
  toolUseId: string;
  oneLiner: string;
  status: 'running' | 'completed' | 'error';
}

interface SubagentInfo {
  agentToolUseId: string;
  description: string;
  steps: SubagentStep[];
  messageTs: string | null;
}

export class SubagentTracker {
  private agents: Map<string, SubagentInfo> = new Map();

  registerAgent(agentToolUseId: string, description: string): void {
    this.agents.set(agentToolUseId, {
      agentToolUseId,
      description,
      steps: [],
      messageTs: null,
    });
  }

  isSubagent(toolUseId: string): boolean {
    return this.agents.has(toolUseId);
  }

  isChildOf(parentToolUseId: string): boolean {
    return this.agents.has(parentToolUseId);
  }

  getAgentCount(): number {
    return this.agents.size;
  }

  getAgentDescription(agentToolUseId: string): string | undefined {
    return this.agents.get(agentToolUseId)?.description;
  }

  setMessageTs(agentToolUseId: string, ts: string): void {
    const agent = this.agents.get(agentToolUseId);
    if (agent) agent.messageTs = ts;
  }

  getMessageTs(agentToolUseId: string): string | null {
    return this.agents.get(agentToolUseId)?.messageTs || null;
  }

  addStep(agentToolUseId: string, step: SubagentStep): void {
    const agent = this.agents.get(agentToolUseId);
    if (agent) agent.steps.push(step);
  }

  updateStepStatus(agentToolUseId: string, toolUseId: string, status: SubagentStep['status']): void {
    const agent = this.agents.get(agentToolUseId);
    if (!agent) return;
    const step = agent.steps.find(s => s.toolUseId === toolUseId);
    if (step) step.status = status;
  }

  getSteps(agentToolUseId: string): SubagentStep[] {
    return this.agents.get(agentToolUseId)?.steps || [];
  }

  getDisplaySteps(agentToolUseId: string, maxVisible: number): { visibleSteps: SubagentStep[]; hiddenCount: number } {
    const steps = this.getSteps(agentToolUseId);
    if (steps.length <= maxVisible) {
      return { visibleSteps: steps, hiddenCount: 0 };
    }
    return {
      visibleSteps: steps.slice(-maxVisible),
      hiddenCount: steps.length - maxVisible,
    };
  }
}
