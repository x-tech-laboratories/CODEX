# Goal

CODEX is a personable personal assistant that runs on the user's own computer. It handles the user's email, calendar, tasks, bookmarks, notes, files and research: noticing what happens, preparing what is needed, and acting where the user allows.

**Built on a harness:** the reasoning, memory and research come from [SmartHarness](https://github.com/x-tech-laboratories/SmartHarness), which makes small local models capable through task trees, a knowledge store and background learning. CODEX adds what an assistant needs around it: a daemon that is always on, interfaces, event sources such as mail, an Inbox of proposed actions, a persona and a face.

**Local by default, hosted by choice:** the model runs on the user's hardware unless the user picks a hosted one, such as Claude or a GPT model, and that choice is made per job: requests can go to a hosted model while background work and mail stay local. Every run names the model it used. CODEX uses whichever model serves the user best, which need not be the small reference model the harness is measured with.

**Asks before it acts:** CODEX proposes; the user approves. Drafts are never sent, and outside content cannot make it change anything unattended.

**The long-range aim:** an always-on assistant that perceives what happens across the user's domains, prioritizes, prepares and reflects, learning in idle time.

**Nothing is settled.** The design in docs 1–2 records what is built and why, not a commitment.

## The docs

- `0-goal.md`: this file.
- `1-architecture.md`: what the assistant adds to the harness, how it works, and why.
- `2-open-questions-and-approaches.md`: the assistant's open questions, and the unbuilt approaches that answer them.
- `3-roadmap.md`: order, status, and how to measure each step.

SmartHarness keeps the same four docs for the harness itself.
