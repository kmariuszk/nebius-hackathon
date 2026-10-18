from gen import (text, area, box, frame, svg, header, escape, OUT, PAD, W,
                 BODY, GREY, BLUE_L, BLUE_D, YEL_L, HEAT)

f10 = header("10. Ten non-obvious ideas",
             "Five that would create a new category, and five that use the tools on the table in ways nobody expects. Same scores as before; totals are Claude's drafts.")

cols = [
    ("idea", 64, 420, "Idea"),
    ("track", 494, 220, "Best track"),
    ("tech", 724, 260, "Technical"),
    ("design", 994, 260, "Design"),
    ("impact", 1264, 260, "Impact"),
    ("quality", 1534, 260, "Idea quality"),
    ("total", 1804, 140, "Total /20"),
    ("build", 1976, 260, "Buildable in 6h"),
    ("magic", 2246, 380, "30-second magic moment"),
    ("risk", 2636, 380, "Biggest risk"),
]
C = {k: (x, w) for k, x, w, _ in cols}

group_a = [
    dict(idea="<b>#15 Deal room</b><br>Your agent and the tradesperson's agent negotiate the renovation contract, each with private limits. Humans only sign.",
         track="<b>Apps and Agentic AI</b><br>+ NVIDIA challenge",
         tech=(5, "Two Nemotron agents, private state, Tavily prices"),
         design=(4, "Watching two agents haggle is live theatre"),
         impact=(4, "Every quote today is a slow email thread"),
         quality=(5, "Agent-to-agent commerce with a real use"),
         build=(4, "Two prompts and a loop; no real counterparty"),
         magic="Type your budget; two agents trade offers on screen for 20 seconds and land on a price, with both sides' reasons shown.",
         risk="Judges ask why a tradesperson would run an agent. Answer: it stops them losing jobs to slow replies."),
    dict(idea="<b>#16 Law as CI</b><br>Paste a law; Nemotron turns each obligation into a check that runs on every push. Tavily watches for amendments.",
         track="<b>Apps and Agentic AI</b><br>+ NVIDIA challenge",
         tech=(5, "Statute parsing, generated checks, GitHub Action"),
         design=(3, "Lives in CI; show a red check turning green"),
         impact=(5, "AI Act obligations bite from August 2026"),
         quality=(5, "Regulation as code, generated from the text"),
         build=(3, "Pick five obligations that are testable"),
         magic="Push a commit that drops alt text; the pipeline fails, quotes the article of the law, and suggests the fix.",
         risk="Most obligations can't be tested from code. Pick the five that can and say so up front."),
    dict(idea="<b>#17 Film a room, get a robot job</b><br>Phone video of a warehouse aisle; the VL model lists objects and hazards, Nemotron writes the task plan a robot can run.",
         track="<b>Vertical AI</b><br>physical AI and robotics<br>+ NVIDIA challenge",
         tech=(5, "Nemotron 3.5 Super VL on frames, then a planner"),
         design=(4, "Video in, annotated plan out is vivid"),
         impact=(4, "Robot deployments start with a site survey"),
         quality=(4, "Scene to task spec is the missing step"),
         build=(3, "Frames and VL are fine; skip the simulator"),
         magic="Walk the phone through the venue's kitchen; 30 seconds later every object is labelled and a 'clear the table' plan appears step by step.",
         risk="VL misses small objects. Demo on a tidy scene you filmed in advance."),
    dict(idea="<b>#18 Waiting room radar</b><br>Patients type symptoms on a tablet before the doctor; the doctor gets a structured intake, and across clinics an outbreak shows early.",
         track="<b>Vertical AI</b><br>healthcare and life sciences<br>+ NVIDIA challenge",
         tech=(4, "Nemotron structures intake; Serverless aggregates"),
         design=(4, "Intake form plus a live city map"),
         impact=(5, "Public health sees outbreaks weeks late"),
         quality=(4, "Turns intake into surveillance; no audio"),
         build=(4, "Text in, JSON out; simulate 200 patients"),
         magic="Three fake patients type 'fever and rash'; the doctor's screen fills itself and a red dot grows on the Neukölln map.",
         risk="Health data and GDPR. Nothing identifying leaves the clinic, and the screen says so."),
    dict(idea="<b>#19 The handover interview</b><br>An agent interviews a leaving engineer, checks the repo and wiki for what's undocumented, and writes the handover nobody writes.",
         track="<b>Apps and Agentic AI</b><br>+ NVIDIA challenge",
         tech=(4, "Repo and wiki read, interview loop, gap finder"),
         design=(4, "Questions get sharper as it finds gaps"),
         impact=(4, "Every departure loses months of context"),
         quality=(5, "AI interviewing humans, not the reverse"),
         build=(4, "Text chat plus a repo; voice optional"),
         magic="Point it at a repo; it asks 'why is the retry limit 7 in payments.py?', you answer, and the handover doc grows live.",
         risk="Needs a real repo with real quirks. Use one of yours, not a toy."),
]

group_b = [
    dict(idea="<b>#20 Thinking on a budget</b><br>Nano answers first and scores its own confidence; hard questions climb to Super, then Ultra. A live meter shows cost saved.",
         track="<b>Cloud and Serverless</b><br>+ NVIDIA challenge",
         tech=(4, "Three Nemotron tiers, verifier, router endpoint"),
         design=(4, "A cost meter that ticks is a story"),
         impact=(4, "Inference bills are every team's problem"),
         quality=(3, "Cascades are known; the product and meter are new"),
         build=(5, "Three API calls and a chart"),
         magic="Fire 50 mixed questions; most stop at Nano, hard ones climb, and the meter shows 80% saved at the same accuracy.",
         risk="Judges ask about accuracy. Run a small eval with answers you already know."),
    dict(idea="<b>#21 Docs to MCP</b><br>Point it at any API docs site; Tavily maps and extracts it, Nemotron writes an MCP server with typed tools, Serverless hosts it.",
         track="<b>Apps and Agentic AI</b><br>+ NVIDIA challenge",
         tech=(5, "Tavily map and extract, codegen, deploy, MCP"),
         design=(3, "Dev tool; show Claude Code using the new tool"),
         impact=(4, "Thousands of APIs have no MCP server"),
         quality=(4, "Tavily as a crawler for codegen, not search"),
         build=(3, "Codegen is flaky; limit to REST with JSON"),
         magic="Paste the Open-Meteo docs URL; 90 seconds later Claude Code asks for tomorrow's rain in Berlin through a server that didn't exist.",
         risk="Generated servers break on auth and odd formats. Demo on one public API you tested."),
    dict(idea="<b>#22 Humans as tools</b><br>An MCP tool called ask_a_human: when the agent is unsure it messages a real person on Telegram, waits, and continues.",
         track="<b>Apps and Agentic AI</b><br>+ NVIDIA challenge",
         tech=(4, "MCP tool, Telegram bot, async wait, Nemotron"),
         design=(5, "A phone buzzes mid-demo; the room gets it"),
         impact=(4, "Stops agents guessing on the one unknown"),
         quality=(5, "Inverts the usual human-in-the-loop"),
         build=(4, "Telegram bots are 20 lines; loop is simple"),
         magic="The renovation agent hits 'which wall is load-bearing?', Ralph's phone buzzes, he replies, and the plan finishes.",
         risk="Looks like a gimmick if the question is trivial. Make it one only a human can know."),
    dict(idea="<b>#23 Distill on the day</b><br>Super writes 500 labelled examples for your task; a Serverless job fine-tunes a small open model; it deploys and matches Super at a fifth of the cost.",
         track="<b>Cloud and Serverless</b><br>+ NVIDIA challenge",
         tech=(5, "Synthetic data, fine-tune job, endpoint, eval"),
         design=(3, "A chart and a URL; make the chart clear"),
         impact=(4, "Everyone wants Super quality at Nano prices"),
         quality=(4, "Distillation as a one-click product"),
         build=(3, "Start the fine-tune by 13:00 or it won't finish"),
         magic="Pick a task; 500 examples stream past, the job runs, and a small model answers from a URL with the same score as Super.",
         risk="The fine-tune doesn't finish. Kick one off at noon with a tiny set as insurance."),
    dict(idea="<b>#24 Hold the line</b><br>An agent calls the Bürgeramt hotline for you, waits in the queue, and when a human answers it handles the request or rings you to take over.",
         track="<b>Apps and Agentic AI</b><br>+ NVIDIA challenge",
         tech=(4, "Twilio call, speech model on Serverless, Nemotron"),
         design=(5, "A phone call on stage is unforgettable"),
         impact=(4, "Berlin's 115 line means long waits for everyone"),
         quality=(4, "Old telephony as the agent's interface"),
         build=(2, "Telephony plus live speech is two risky parts"),
         magic="Dial a mentor's phone; the agent sits through a fake hold loop, then books an appointment with the mentor playing the clerk.",
         risk="Never call a real public office from the stage. A mentor's phone is the office."),
]


def group(title, y_title, ideas):
    out = [text(PAD, y_title, title, 33, bold=True)]
    hy = y_title + 26
    for k, x, w, label in cols:
        out.append(box(x, hy, w, 80, BLUE_L, label, 22, BLUE_D, "left", "middle"))
    ry0, rh, rg = hy + 90, 200, 10
    for i, d in enumerate(ideas):
        y = ry0 + i * (rh + rg)
        for k in ("idea", "track", "magic", "risk"):
            x, w = C[k]
            out.append(box(x, y, w, rh, GREY, d[k]))
        total = 0
        for k in ("tech", "design", "impact", "quality", "build"):
            x, w = C[k]
            score, why = d[k]
            assert len(why) <= 50, why
            if k != "build":
                total += score
            fill, ink = HEAT[score]
            out.append(box(x, y, w, rh, fill))
            out.append(text(x + 20, y + 20 + 36, str(score), 33, ink, bold=True))
            out.append(area(x + 20, y + 76, w - 40, escape(why), 22, ink))
        x, w = C["total"]
        out.append(box(x, y, w, rh, BLUE_L, f"<b>{total}</b>", 33, BLUE_D, "center", "middle"))
        print(d["idea"].split("</b>")[0][3:], total, d["build"][0])
    return out, ry0 + len(ideas) * (rh + rg) - rg


a, end_a = group("A. Revolutionizing: a new category, not a better version of something that exists", 250, group_a)
b, end_b = group("B. Unconventional: the tools on the table, used the way nobody expects", end_a + 64 + 33, group_b)
f10 += a + b

PY = end_b + 64
f10.append(box(PAD, PY, W - 2 * PAD, 170, YEL_L,
               "<b>What changes: #15 Deal room, #16 Law as CI and #22 Humans as tools tie with #2 at 18.</b> #22 is as much a feature as an idea: bolt ask_a_human onto #3, #9 or #15 and it becomes the magic moment. #15 is the safest of the three to build. #16 is the most ambitious; only pick it if one of you knows GitHub Actions well. "
               "<b>Bonus for tonight, 30 minutes:</b> a judge simulator. Paste the assumed rubric and your demo script; five Nemotron personas score it and ask the Q&A questions. Rehearse against it before 09:00."))

F10_H = PY + 170 + 64
open(f"{OUT}/f10.svg", "w").write(svg(frame("f10", 3400, 6180, F10_H, "10 Ten non-obvious ideas", f10)))
print("height", F10_H)
