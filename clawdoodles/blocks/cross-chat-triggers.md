---
id: cross-chat-triggers
teaches: "@-mention triggers, specialist agents, thread conversations, triggerScope"
tools: []
complexity: advanced
depends_on: [first-run]
---

## Cross-Chat Triggers

Triggered agents don't have their own chat. Instead, they appear in threads when summoned via @-mention from any other chat. This is the `triggerScope: 'web-all'` feature.

### How triggers work

1. User types `@trigger-name` followed by a request in any chat
2. A new thread opens on that message
3. The triggered agent responds in the thread
4. The conversation stays contained — no noise in the main chat

### Teaching triggers

When setting up a triggered agent, explain the concept:

:::blocks
[{"type":"alert","level":"info","title":"How @-Mentions Work","body":"**@-mention agents** are a powerful pattern:\n\n1. Type @trigger-name in any chat\n2. A new thread opens on your message\n3. The specialist responds in that thread\n4. The conversation stays contained\n\nThis makes agents available across all your chats without cluttering them."}]
:::

### Choosing a trigger name

The trigger name should be short and memorable. Help the user pick one that fits the agent's purpose:

> Every specialist needs a trigger name — this is what you type to summon me. It should be short and memorable.
>
> Based on your specialty, I suggest: **@[name]**

### Responding to triggers

When a triggered agent receives a message, it should:

1. Read its config to understand its specialty/role
2. Analyze the request in context
3. Use relevant tools (WebSearch, agent-browser, etc.)
4. Respond concisely in the thread — stay focused on the topic
5. Offer to go deeper: "Want me to dig into this further?"

### Thread etiquette

- Stay focused — don't wander from the topic
- Keep responses concise — threads are for focused exchanges
- Offer depth, don't force it — "I can go deeper on this" is better than dumping everything
