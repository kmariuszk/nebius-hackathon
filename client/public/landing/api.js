// Every call the landing pages make to the board service. The endpoints follow
// Concept.md's REST API; base path from ML_CONFIG.apiBase, JSON in and out,
// errors as {"error": {"code", "message"}}.
//
//   Start page, on submit:
//     POST /boards                     {title, question, context}           -> Board
//     POST /boards/{id}/seeds          {doi} | {pmid} | multipart "file"    -> Paper   (once per paper)
//     then the browser opens ML_CONFIG.boardUrl(board.id) + "?start=1": the board opens its
//     chat and sends the agent its first prompt. With sample data only:
//     POST /boards/{id}/runs           {kind: "onboarding"}                 -> Run
//   Home page:
//     GET  /boards                                                          -> [Board]
//
// Fields the pages read (other fields are ignored):
//   Board: {id, title, question?, seedCount?, paperCount?, newCount?, members?: [{displayName}] | [string]}
//   Run:   {id, status}
//
// Notes for the backend:
//   - {pmid} is an addition to the contract: researchers paste PubMed links as often as DOIs.
//   - A PDF is looked up by the first DOI on its first two pages, else by its title; one it can't
//     place is a 422 whose message the page shows, and the other papers still become seeds.
//   - question may be empty (papers only): the agent drafts a question from the seeds.
//   - No seeds (question only): the board starts from search hits (Concept.md flow 2).
//   - Login is faked: the display name is kept in localStorage and sent as X-Display-Name.
(function () {
  const C = window.ML_CONFIG;
  const mock = C.mock || new URLSearchParams(location.search).get('mock') === '1';

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // Demo-grade identity (matches client/identity.ts): a member ID made once per
  // browser and trusted by the server as `Authorization: Bearer <memberId>`.
  const MEMBER_KEY = 'pdc.memberId';
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  function getMemberId() {
    let id = localStorage.getItem(MEMBER_KEY);
    if (!id || !/^m_[a-z0-9]{10}$/.test(id)) {
      const bytes = crypto.getRandomValues(new Uint8Array(10));
      id = 'm_' + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
      localStorage.setItem(MEMBER_KEY, id);
    }
    return id;
  }

  function headers(json) {
    const h = { Accept: 'application/json', Authorization: `Bearer ${getMemberId()}` };
    if (json) h['Content-Type'] = 'application/json';
    const name = localStorage.getItem('ml-name');
    if (name) h['X-Display-Name'] = name;
    return h;
  }

  async function call(method, path, body) {
    const isForm = body instanceof FormData;
    let res;
    try {
      res = await fetch(C.apiBase + path, {
        method,
        headers: headers(body !== undefined && !isForm),
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'Can’t reach the board service.');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError(res.status, data?.error?.message || `The board service answered ${res.status}.`);
    return data;
  }

  const real = {
    createBoard: ({ title, question, context }) => call('POST', '/boards', { title, question, context }),
    addSeed: (boardId, seed) => {
      const path = `/boards/${encodeURIComponent(boardId)}/seeds`;
      if (seed.file) { const f = new FormData(); f.append('file', seed.file, seed.file.name); return call('POST', path, f); }
      return call('POST', path, seed.doi ? { doi: seed.doi } : { pmid: seed.pmid });
    },
    listBoards: () => call('GET', '/boards'),
  };

  // Sample data in the same shapes, for working on the pages without the board service.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fake = {
    createBoard: async (b) => { await wait(250); console.info('[mock] POST /boards', b); return { id: 'b_mock' + Math.random().toString(36).slice(2, 8), ...b }; },
    addSeed: async (id, s) => { await wait(120); console.info(`[mock] POST /boards/${id}/seeds`, s.file ? { file: s.file.name } : s); return { paperId: 'mock' }; },
    startRun: async (id, kind) => { await wait(150); console.info(`[mock] POST /boards/${id}/runs`, { kind }); return { id: 'run_mock', status: 'running' }; },
    listBoards: async () => { await wait(200); return [
      { id: 'b_melanoma', title: 'Melanoma immune cells', seedCount: 5, paperCount: 23, newCount: 4, members: ['Ana', 'Igor', 'Ralph'] },
      { id: 'b_cd4', title: 'CD4 T-cell help', seedCount: 3, paperCount: 11, newCount: 5, members: ['Ana'] },
    ]; },
  };

  window.MLApi = { ...(mock ? fake : real), mock, ApiError };
})();
