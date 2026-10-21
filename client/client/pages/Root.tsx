import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { uniqueId } from 'tldraw'

// `/` is the Start page (T16). The landing pages are static files, not React, so it's a full page load.
export function Root() {
	useEffect(() => window.location.replace('/landing/index.html'), [])
	return null
}

// `/new`: the multiplayer starter's quick room, a fresh one each time
export function NewRoom() {
	const [roomId] = useState(() => `test-room-${uniqueId()}`)
	return <Navigate replace to={`/${roomId}`} />
}
