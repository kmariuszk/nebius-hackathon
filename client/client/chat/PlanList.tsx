import type { PlanEntry } from '@agentclientprotocol/sdk'

// The agent's plan as a checklist at the top of its turn; each update replaces it.
export function PlanList({ entries }: { entries: PlanEntry[] }) {
	if (!entries.length) return null
	const done = entries.filter((e) => e.status === 'completed').length
	return (
		<div className="ChatPlan">
			<div className="ChatPlan-h">
				Plan · {done} of {entries.length} done
			</div>
			<ol>
				{entries.map((e, i) => (
					<li key={i} data-status={e.status}>
						<span className="ChatPlan-mark" aria-label={e.status.replace('_', ' ')}>
							{e.status === 'completed' ? '✓' : e.status === 'in_progress' ? <span className="spin" /> : null}
						</span>
						<span>{e.content}</span>
					</li>
				))}
			</ol>
		</div>
	)
}
