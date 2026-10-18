import type { PermissionOption } from '@agentclientprotocol/sdk'
import type { PermissionItem } from './chatState'

// session/request_permission: the tool the agent wants to run and its options as buttons.
export function PermissionPrompt({
	item,
	onAnswer,
}: {
	item: PermissionItem
	onAnswer: (requestId: string, option: PermissionOption) => void
}) {
	return (
		<div className="ChatPermission" role="group" aria-label="The agent asks for permission">
			<div>
				The agent wants to: <b>{item.title}</b>
			</div>
			{item.answer === null ? (
				<div className="ChatPermission-options">
					{item.options.map((o) => (
						<button
							key={o.optionId}
							type="button"
							className={o.kind.startsWith('allow') ? 'ChatBtn ChatBtn--primary' : 'ChatBtn'}
							onClick={() => onAnswer(item.requestId, o)}
						>
							{o.name}
						</button>
					))}
				</div>
			) : (
				<div className="ChatPermission-answer">{item.answer === 'cancelled' ? 'Cancelled' : `You chose: ${item.answer}`}</div>
			)}
		</div>
	)
}
