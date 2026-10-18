// Settings for the landing pages. Nothing here is secret: it ships to the browser.
window.ML_CONFIG = {
  // Base URL of the board service's REST API (Concept.md, "REST API (board service)").
  apiBase: '/api/v1',
  // Where a board opens. The canvas route today is /:roomId (client/client/pages/Room.tsx).
  boardUrl: (boardId) => `/${encodeURIComponent(boardId)}`,
  // Added to the board URL to start "Catch me up" when the board opens.
  tourQuery: 'tour=1',
  // A prepared example board to explore without starting a run. The link is hidden while empty.
  demoBoardUrl: '',
  // The 2-minute demo video (YouTube or Loom embed URL, or an .mp4). The section is hidden while empty.
  demoVideoUrl: '',
  repoUrl: 'https://github.com/kmariuszk/nebius-hackathon',
  // true: use built-in sample data instead of the board service. Also on with ?mock=1 in the URL.
  mock: false,
};
