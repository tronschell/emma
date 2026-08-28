---
name: threads
description: How to run work across several of Emma's threads with the `threads` tool — starting one per job so each gets its own agent and its own timeline, checking on them, reading what they found, and steering or messaging one mid-flight. Use whenever the user asks to spin up, split, fan out, check on, steer or message threads, and whenever a request holds two or more jobs that each deserve a conversation of their own.
---

# Threads

A **thread** is a conversation timeline: it stores the whole event
stream — messages, tool calls, file edits — it outlives every agent that ever
ran in it, and it stays in the user's sidebar to be picked up, resumed or
forked days later. A **thread is a place.**

An **agent** is the execution loop working inside one. A subagent — what `task`
spawns — is a temporary worker: it takes a job, answers into this turn, and
dissolves. An **agent is a shift of work.**

So:

| The user wants | Use | Why |
| --- | --- | --- |
| an answer inside this turn | `task` | a worker that dissolves once it answers |
| several answers at once, all reported back here | `task`, several calls | same, in parallel |
| work that keeps its own history and gets picked up later | `threads spawn` | a place, not a shift |
| "spin up a few threads", "one thread per X" | `threads spawn`, once per job | the user is asking for places |

When the user says *thread*, they mean a row in their sidebar. Do not hand them
a subagent instead: its transcript is not in the sidebar and it is gone by the
end of this turn.

## Starting them

One call per thread. Give each a title of three or four words and a prompt
complete enough to be worked on by an agent that cannot see this conversation:

    threads {"action":"spawn","title":"Audit the auth flow","prompt":"Read crates/host/src/main.rs and list every place a request is dispatched without checking the sender. Report what you find; do not change anything."}

Each spawn returns the new thread's ID and puts a main agent to work in it
immediately. That agent:

- runs **beside** this turn — nothing comes back here, ever;
- inherits this turn's permission mode, so it can do exactly what you can;
- works in this project, and its thread is nested under this one in the sidebar.

The user gets a live card in the transcript for each one — status, what it is
doing, Open, Stop, and a line to send it. Say what you started and what each is
for; do not narrate the mechanics.

Spawn **without** a prompt when the thread is a place for the *user* to work,
not an agent: a parked idea, the next piece of a project, somewhere to come back
to. It is created empty and nothing runs in it.

Emma runs at most eight threads at once. Over that, a spawn is refused rather
than queued — start the important ones first.

## Checking on them

    threads {"action":"list"}

Every thread with its owner, message count, and — for the ones working right
now — the run's status and what it is doing this moment. That is the only place
live status appears; a spawned thread's own answer lands in its own transcript.

    threads {"action":"read","thread":"<id>","limit":20}

The most recent messages of one thread, which is how you collect what a thread
you started has worked out, and how a subagent with no sight of the
conversation it came from goes and finds it.

Do not poll in a loop. Read a thread when you have a reason to — the user asked,
or you need its result to carry on. A thread that is still running has nothing
new to say yet.

## Steering and messaging

    threads {"action":"message","thread":"<id>","prompt":"skip the tests directory"}

One door, two behaviours: it steers the agent working in that thread when one
is — arriving with its next batch of tool results, so nothing in flight is lost
— and starts a turn of its own when the thread is quiet. From out here, "talk to
that thread" is one intention.

Two refusals worth knowing:

- The thread this turn is in. Say it in your answer instead.
- A thread the coding harness is running. The harness takes nothing mid-turn,
  so the message would be swallowed rather than delivered. Wait for it to
  finish — `list` says when it has — and send it then.

## Naming

    threads {"action":"rename","title":"Rome in June"}

Renames the thread this turn is in. Do it once, unasked, when a thread still
called "New thread" has settled into a subject. It is the row the user scans.

## Working with several at once

A good fan-out is one thread per **independent** job. Threads spawned into the
same project share one coding harness and take their turns one after another,
so splitting one job across five threads buys nothing and costs five
transcripts. Split by subject, not by step:

- ✅ one thread per service being migrated, per bug being chased, per document
  being drafted
- ❌ one thread for "read the file", one for "make the change", one for "run
  the tests"

Report back in one line each: what you started, and what each thread is for.
