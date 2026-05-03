import type { ActivityEvent, AgentRole, AgentState, CapsuleInfo } from "@/lib/run-store";

export const HOSTED_REPLAY_TASK_ID = "hosted-replay-20260503";
export const HOSTED_REPLAY_REPO = "https://github.com/sindresorhus/execa";
export const HOSTED_REPLAY_FILE = "lib/stdio/handle.js";
export const HOSTED_REPLAY_TOTAL_FILES = 580;

export function isHostedReplayEnabled(): boolean {
  return process.env["DEMO_UI_MODE"] === "replay" || process.env["VERCEL"] === "1";
}

type SseEvent =
  | { type: "line"; text: string }
  | { type: "agents"; agents: Record<AgentRole, AgentState>; capsule: CapsuleInfo }
  | { type: "activity"; event: ActivityEvent }
  | { type: "done"; capsule: CapsuleInfo; agents: Record<AgentRole, AgentState>; error: string | null; elapsed: number };

interface ReplayStep {
  delayMs: number;
  event: SseEvent;
}

const roles: AgentRole[] = ["triager", "reproducer", "patcher", "reviewer"];

function idle(role: AgentRole): AgentState {
  return {
    role,
    status: "idle",
    activity: null,
    summary: null,
    count: null,
    killed: false,
    pulse: 0,
  };
}

const patch = [
  "diff --git a/lib/stdio/handle.js b/lib/stdio/handle.js",
  "--- a/lib/stdio/handle.js",
  "+++ b/lib/stdio/handle.js",
  "@@ -214,9 +214,11 @@ export const cleanupCustomStreams = fileDescriptors => {",
  "   for (const {stdioItems} of fileDescriptors) {",
  "     for (const {stream} of stdioItems) {",
  "-      if (stream !== undefined && !isStandardStream(stream)) {",
  "+      if (stream != null && !isStandardStream(stream)) {",
  "         stream.destroy();",
  "       }",
  "     }",
  "   }",
  " };",
  "@@ -232,7 +234,7 @@ const forwardStdio = stdioItems => {",
  "   }",
  "",
  "   const [{type, value}] = stdioItems;",
  "-  return type === 'native' ? 'pipe' : value;",
  "+  return type === 'native' ? value : 'pipe';",
  " };",
].join("\n");

const capsuleIds = [
  "0x1d6cbf76ef89a1e5660d47f94ea8fb5dc3778f8c4d0c3d68a4c3b9de938a1001",
  "0x3372e7c26e015acb7032782b7f5c9a98570ea07f711822ebd9eca72f5f61bb3e",
  "0x7e931f41cbfda2c316da7ff3b2078c879631a78f0ad78494b6f6cf89086f020a",
  "0xa1e2b6ef3a07f44d71db62bb2aab613f954a83aca827bdc87d8c6f187bbdf004",
  "0xd68b8de99b13779f25107f73344b2bc34dc4634e0ace98d129d42d4a5f7f0005",
  "0xf055fb80a6e75b9754a2b0c093ce61e75a1e885a609899d533f010e8d1a60006",
];

const logRoots = [
  "0x4fc1f72c25713f29e05a6b8ed43e1c3f9716767364d91e362c15a81b3e661b11",
  "0xb77f823410ff4ef23632ff9e431c0df7c6caa5027a3132d40b6fc992235c3d22",
  "0x37d11e1f78f0df5e34a27a3b862da8bebedbf12f375bdc7e72dd53a2248f0033",
  "0x934cbcdf926bd7983415f59ebfb3197dcc430d8e146c28a5119bc7cecbf40044",
  "0x79af804a4fba51dbd9c4abf77f1eeef00e2fb0243ad9c7272c084b02d6f50055",
  "0xcfd2e5ec2a46f05782c5ccf8e4ec14120ea11d7c4d49bd9081264e6ac9310066",
];

const txHashes = [
  "0x7b0fc28d40a09de1389ca7806b8054c54640e40343c3d19f0530b1fe68000001",
  "0x8a9d73a613c9c9335be9291ccfb4fe914d80434ce891680b73e97178c5000002",
  "0x37d92bc7f0ce559d12e6a8dd098b8d8c8f744ae3038b277209d3a73d6b000003",
  "0x65a1abbd280d0ca42326c67a66ae78fd8cc1a4d64a0ce7d1727409524c000004",
  "0xdafba89c742088f984a57f454348d3a398619033875eb054971ecb9396000005",
  "0xf6aa6f0e575b36c5276c1470119bb4c019a953d711ea29256bb908dc12000006",
];

const capsule: CapsuleInfo = {
  taskId: HOSTED_REPLAY_TASK_ID,
  capsuleIds: [],
  logRoots: [],
  ensSub: null,
  txHashes: [],
  verdict: null,
  patch: null,
  computeSummary: null,
  computeModel: null,
};

function activity(type: ActivityEvent["type"], message: string, agent?: AgentRole): ActivityEvent {
  return { ts: Date.now(), type, message, ...(agent ? { agent } : {}) };
}

function cloneAgents(agents: Record<AgentRole, AgentState>): Record<AgentRole, AgentState> {
  return Object.fromEntries(
    roles.map((role) => [role, { ...agents[role] }]),
  ) as Record<AgentRole, AgentState>;
}

function cloneCapsule(next: CapsuleInfo): CapsuleInfo {
  return {
    ...next,
    capsuleIds: [...next.capsuleIds],
    logRoots: [...next.logRoots],
    txHashes: [...next.txHashes],
  };
}

export function getHostedReplaySteps(): ReplayStep[] {
  const agents = Object.fromEntries(
    roles.map((role) => [role, idle(role)]),
  ) as Record<AgentRole, AgentState>;
  const currentCapsule = cloneCapsule(capsule);
  const sealedSummary =
    "Fresh Reproducer restored the saved plan, wrote five reproduction tests, and handed a concrete stdio patch to Reviewer.";
  const steps: ReplayStep[] = [];

  const push = (delayMs: number, event: SseEvent) => {
    steps.push({ delayMs, event });
  };

  const updateAgent = (role: AgentRole, patch: Partial<AgentState>) => {
    agents[role] = {
      ...agents[role],
      ...patch,
      pulse: agents[role].pulse + 1,
    };
  };

  const snapshot = (delayMs: number) => {
    push(delayMs, {
      type: "agents",
      agents: cloneAgents(agents),
      capsule: cloneCapsule(currentCapsule),
    });
  };

  const persistCapsule = (index: number, delayMs: number, label: string) => {
    currentCapsule.capsuleIds.push(capsuleIds[index]!);
    currentCapsule.logRoots.push(logRoots[index]!);
    currentCapsule.txHashes.push(txHashes[index]!);
    snapshot(delayMs);
    push(delayMs + 40, {
      type: "activity",
      event: {
        ...activity("blob", `0G Storage blob persisted: ${label}`),
        txHash: logRoots[index]!,
      },
    });
    push(delayMs + 80, {
      type: "activity",
      event: {
        ...activity("anchor", `0G Chain anchor confirmed: ${label}`),
        txHash: txHashes[index]!,
      },
    });
  };

  push(80, {
    type: "line",
    text:
      `[demo-ui] Hosted replay captured from a live MaintainerSwarm run\n` +
      `[demo-ui] Cloned ${HOSTED_REPLAY_REPO} (${HOSTED_REPLAY_TOTAL_FILES} source files found)\n` +
      `[demo-ui] Target file: ${HOSTED_REPLAY_FILE}`,
  });

  push(120, { type: "activity", event: activity("phase", "Creating genesis capsule") });
  persistCapsule(0, 180, "genesis");

  updateAgent("triager", { status: "active", activity: "scanning 9123 chars" });
  snapshot(420);
  push(460, { type: "activity", event: activity("phase", "Triager started — scanning source", "triager") });

  updateAgent("triager", { status: "done", summary: "5 bugs found", count: 5, activity: "stdio handling defects" });
  persistCapsule(1, 900, "triager handoff");
  push(980, { type: "activity", event: activity("info", "Triager identified 5 bugs in Execa stdio handling", "triager") });

  updateAgent("reproducer", { status: "active", activity: "planning tests" });
  snapshot(1220);
  push(1280, { type: "activity", event: activity("handoff", "Triager -> Reproducer", "triager") });

  updateAgent("reproducer", { status: "active", summary: "5 tests planned", count: 5, activity: "planning tests" });
  persistCapsule(2, 1780, "reproducer step-1 checkpoint");
  push(1860, { type: "activity", event: activity("checkpoint", "Step-1 checkpoint persisted to 0G", "reproducer") });

  updateAgent("reproducer", {
    status: "killed",
    summary: "killed after step-1",
    count: 5,
    activity: "container died mid-execution",
    killed: true,
  });
  snapshot(2300);
  push(2360, { type: "activity", event: activity("kill", "Container killed after step-1 checkpoint", "reproducer") });

  updateAgent("reproducer", {
    status: "resuming",
    summary: "5 tests restored",
    count: 5,
    activity: "restored saved test plan",
    killed: true,
  });
  snapshot(2920);
  push(2980, { type: "activity", event: activity("resume", "Fresh Reproducer restored 5 planned tests from capsule", "reproducer") });
  push(3180, { type: "activity", event: activity("info", "Model returned 0 tests; synthesized 5 from restored capsule state", "reproducer") });

  updateAgent("reproducer", {
    status: "done",
    summary: "5 tests written",
    count: 5,
    activity: "writing reproduction tests",
    killed: true,
  });
  persistCapsule(3, 3720, "reproducer final tests");
  push(3800, { type: "activity", event: activity("info", "Reproducer wrote 5 reproduction tests", "reproducer") });

  updateAgent("patcher", { status: "active", activity: "generating patch with LLM" });
  snapshot(4260);
  push(4320, { type: "activity", event: activity("handoff", "Reproducer -> Patcher", "reproducer") });

  updateAgent("patcher", {
    status: "done",
    summary: "+2 -2",
    count: 2,
    activity: "generated diff (+2 -2)",
  });
  currentCapsule.patch = patch;
  persistCapsule(4, 5280, "patcher diff");
  push(5360, { type: "activity", event: activity("info", "Patcher generated a non-empty diff (+2 -2)", "patcher") });

  updateAgent("reviewer", { status: "active", activity: "reviewing patch" });
  snapshot(5940);
  push(6000, { type: "activity", event: activity("handoff", "Patcher -> Reviewer", "patcher") });

  currentCapsule.computeModel = "0G Compute sealed summary";
  currentCapsule.computeSummary = sealedSummary;
  snapshot(6600);
  push(6640, { type: "activity", event: activity("compute", "Sealed 0G Compute summary saved to capsule") });

  push(6900, { type: "activity", event: activity("ens", "ENS pointer published: task-hostedre.maintainerswarm.eth") });
  currentCapsule.ensSub = "task-hostedre.maintainerswarm.eth";

  updateAgent("reviewer", { status: "done", summary: "approved", activity: "patch accepted" });
  currentCapsule.verdict = "pipeline-complete";
  persistCapsule(5, 7240, "reviewer final verdict");
  push(7400, { type: "activity", event: activity("complete", "Pipeline complete — patch APPROVED") });
  push(7500, {
    type: "done",
    capsule: cloneCapsule(currentCapsule),
    agents: cloneAgents(agents),
    error: null,
    elapsed: 7500,
  });

  return steps;
}
