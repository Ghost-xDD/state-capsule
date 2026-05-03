# @ghostxd/state-capsule-adapter-langchain

State Capsule `BaseMemory` subclass + Runnable wrapper for [LangChain.js](https://github.com/langchain-ai/langchainjs). Every chain step is checkpointed as a signed capsule on 0G Storage, so agents can resume from the last capsule after a crash.

```ts
import { StateCapsule }                     from "@ghostxd/state-capsule-sdk";
import { StateCapsuleMemory, withCapsuleMemory } from "@ghostxd/state-capsule-adapter-langchain";

const sdk    = new StateCapsule({ privateKey: process.env.CAPSULE_PRIVATE_KEY });
const memory = new StateCapsuleMemory(sdk, { taskId: "fix-bug-42", holder: "agent" });

// Load current context into chain inputs
const { capsule_context } = await memory.loadMemoryVariables({});

// Wrap any Runnable to auto-checkpoint after each call
const chain   = prompt.pipe(llm).pipe(parser);
const wrapped = withCapsuleMemory(chain, memory);
const result  = await wrapped.invoke({ input: "What's next?" });
```
