import "./journey.css";

export interface LibraryRow {
    id: string; title: string; artist: string; previewing?: boolean; filename: string; status: string; duration?: number; bpm?: number; offset?: number;
    message?: string; playable: boolean; missing: boolean; protected: boolean;
}
export interface PlaylistRow { id: string; name: string; trackIds: string[] }
export interface ArenaCard { id: string; name: string; description: string; reward: string; pressure: string }
export interface JourneyView {
    phase: string; open: boolean; busy: boolean; error?: string; notice?: string;
    storage: string; available: boolean; tracks: LibraryRow[]; playlists: PlaylistRow[];
    active?: { title: string; status: string; songIndex: number; total: number; level: number; xp: number; requiredXp: number; health: number; upgrades: string[] };
    route?: { title: string; duration: number; timing: string; completed?: string; current: boolean }[];
    choices?: ArenaCard[]; retrySave?: boolean; campaign: boolean;
}
export interface JourneyActions {
    close(): void; preview(id: string): Promise<unknown>; import(files: File[]): Promise<unknown>; quickPlay(id: string): Promise<unknown>;
    analyze(id: string): Promise<unknown>; manual(id: string, bpm: number, offset: number): Promise<unknown>;
    rename(id: string, title: string, artist: string): Promise<unknown>; remove(id: string): Promise<unknown>; relink(id: string, file: File): Promise<unknown>;
    savePlaylist(id: string | undefined, name: string, tracks: string[]): Promise<string>;
    deletePlaylist(id: string): Promise<unknown>; startPlaylist(id: string): Promise<unknown>;
    continue(): Promise<unknown>; arena(id: string): Promise<unknown>; abandon(): Promise<unknown>;
    export(): Promise<unknown>; recover(file: File): Promise<unknown>; persist(): Promise<unknown>; retrySave(): Promise<unknown>; reloadSave(): Promise<unknown>;
}
const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const time = (v = 0) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
const button = (action: string, label: string, extra = "") => `<button type="button" class="bs-button bs-button-outline" data-j="${action}" ${extra}>${label}</button>`;

/** Local library / route UI. All user-provided labels are text-escaped. */
export function mountJourneyUI(container: HTMLElement, actions: JourneyActions) {
    const root = document.createElement("div");
    root.className = "bs-ui bs-journey-ui";
    root.hidden = true;
    container.append(root);
    const events = new AbortController();
    let view: JourneyView;
    let tab: "library" | "playlists" | "route" | "recovery" = "library";
    let signature = "";
    let draftId: string | undefined;
    let draftName = "My ten-song run";
    let draft: string[] = [];
    let songToAdd = "";
    let detail: string | undefined;
    let selectedArena: string | undefined;
    let confirmation: "replace" | "abandon" | "delete-track" | "delete-playlist" | "recover" | undefined;
    let confirmationId: string | undefined;
    let recoveryFile: File | undefined;
    let localError = "";
    let running = false;
    let wasOpen = false;
    let previousMapKey = "";
    let previousPanelKey = "";
    let focusBefore: HTMLElement | null = null;
    const execute = async (fn: () => Promise<unknown>) => {
        if (running) return;
        localError = ""; running = true; render(true);
        try { await fn(); } catch (error) { localError = error instanceof Error ? error.message : String(error); }
        finally { running = false; render(true); }
    };
    const save = async () => {
        if (!draftName.trim()) throw new Error("Give your playlist a name.");
        if (!draft.length) throw new Error("Add at least one song to this playlist.");
        draftId = await actions.savePlaylist(draftId, draftName.trim(), [...draft]);
        return draftId;
    };
    const render = (force = false) => {
        if (!view) return;
        const visible = view.open || view.phase === "map" || view.phase === "settling";
        root.hidden = !visible;
        if (!visible) { wasOpen = false; return; }
        if (!wasOpen) {
            focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            if (view.phase === "map") tab = "route";
            wasOpen = true; signature = "";
        }
        const mapKey = view.phase === "map" ? `${view.active?.title}:${view.active?.songIndex}` : "";
        if (mapKey && mapKey !== previousMapKey) { tab = "route"; selectedArena = undefined; }
        previousMapKey = mapKey;
        const key = JSON.stringify([view, tab, draftId, draftName, draft, detail, selectedArena, confirmation, localError, running]);
        if (!force && signature === key) return;
        signature = key;
        const focusedElement = root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
        const focused = focusedElement?.id;
        const focusedAction = focusedElement?.dataset.j;
        const focusedId = focusedElement?.dataset.id;
        const focusedIndex = focusedElement?.dataset.index;
        const inputValue = focusedElement instanceof HTMLInputElement ? focusedElement.value : undefined;
        const selectionStart = focusedElement instanceof HTMLInputElement ? focusedElement.selectionStart : undefined;
        const confirmationWasOpen = !!root.querySelector(".bs-j-confirm");
        const panelKey = tab === "route" ? `${tab}:${view.active?.title}:${view.active?.songIndex}` : tab;
        const scroll = panelKey === previousPanelKey ? root.querySelector(".bs-journey-body")?.scrollTop ?? 0 : 0;
        previousPanelKey = panelKey;
        const editingValues = !force ? [...root.querySelectorAll<HTMLInputElement>('input:not([type="file"])')]
            .map(input => [input.id, input.value] as const) : [];
        const track = view.tracks.find(t => t.id === detail);
        const total = draft.reduce((sum, id) => sum + (view.tracks.find(t => t.id === id)?.duration ?? 0), 0);
        const nextSong = view.active ? view.route?.[view.active.songIndex] : undefined;
        const remaining = view.route?.slice(view.active?.songIndex ?? 0).reduce((sum, song) => sum + song.duration, 0) ?? 0;
        const ready = draft.length > 0 && draft.every(id => view.tracks.some(t => t.id === id && t.playable));
        const disabled = view.busy || running;
        const content = tab === "library" ? `
            <div class="bs-journey-heading"><div><p class="bs-j-eyebrow">YOUR MUSIC · ON THIS DEVICE</p><h1>Music library</h1><p>Drop several tracks here. We keep the audio and its timing for your next run.</p></div><label class="bs-button bs-button-primary" tabindex="0" role="button">Add songs<input id="bs-library-files" type="file" accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac" multiple hidden></label></div>
            <div class="bs-library-list">${view.tracks.length ? view.tracks.map(t => `<article class="bs-library-row" data-track-id="${escape(t.id)}"><div class="bs-j-disc" aria-hidden="true">♪</div><div class="bs-j-song"><h2>${escape(t.title)}</h2><p>${t.duration ? time(t.duration) : "—"} ${t.bpm ? ` · ${Math.round(t.bpm)} BPM` : ""} · <span data-status="${escape(t.status)}">${escape(t.status.replaceAll("-", " "))}</span></p>${t.message ? `<small>${escape(t.message)}</small>` : ""}</div><div class="bs-j-actions">${button("preview", t.previewing ? "Stop preview" : "Preview timing", `data-id="${escape(t.id)}" ${!t.playable ? "disabled" : ""}`)}${button("quick", "Quick Play", `data-id="${escape(t.id)}" ${!t.playable ? "disabled" : ""}`)}${button("detail", "Manage", `data-id="${escape(t.id)}"`)}</div></article>`).join("") : `<div class="bs-j-empty"><strong>Your soundtrack starts here.</strong><p>Add your songs, then arrange a playlist. Each song becomes one stage of your run.</p></div>`}</div>
            ${track ? `<section class="bs-j-detail"><div class="bs-j-row"><h2>${escape(track.title)}</h2>${button("detail", "Close details")}</div><label>Title <input id="bs-library-title" value="${escape(track.title)}" maxlength="160"></label><label>Artist <input id="bs-library-artist" value="${escape(track.artist)}" maxlength="160"></label>${button("rename", "Save details", `data-id="${escape(track.id)}"`)}<div class="bs-j-row"><label>BPM <input id="bs-library-bpm" type="number" min="20" max="300" value="${Math.round(track.bpm ?? 120)}"></label><label>First beat (seconds) <input id="bs-library-offset" type="number" min="0" step="0.01" value="${track.offset ?? 0}"></label></div><div class="bs-j-actions">${button("manual", "Use manual timing", `data-id="${escape(track.id)}"`)}${button("analyze", "Analyze again", `data-id="${escape(track.id)}"`)}<label class="bs-button bs-button-outline" tabindex="0" role="button">Relink original audio<input id="bs-library-relink" data-id="${escape(track.id)}" type="file" accept="audio/*" hidden></label>${button("remove", "Delete song", `data-id="${escape(track.id)}" ${track.protected ? "disabled title='Used by the active run'" : ""}`)}</div><p>${track.protected ? "This recording and its timing are protected while your campaign is active. " : ""}Timing edits apply to future runs. Relinking requires the exact same recording.</p></section>` : ""}`
        : tab === "playlists" ? `
            <div class="bs-journey-heading"><div><p class="bs-j-eyebrow">BUILD YOUR SET</p><h1>Playlists</h1><p>A ten-song journey, or a shorter run. Repeats are welcome when you add them yourself.</p></div>${button("new-playlist", "New playlist")}</div>
            <div class="bs-j-playlist-layout"><aside class="bs-j-saved">${view.playlists.map(p => button("edit-playlist", `${escape(p.name)} <small>${p.trackIds.length} songs</small>`, `data-id="${escape(p.id)}" aria-pressed="${p.id === draftId}"`)).join("") || "<p>No saved playlists yet.</p>"}</aside><section class="bs-j-editor"><label>Playlist name<input id="bs-playlist-name" value="${escape(draftName)}" maxlength="160"></label><div class="bs-j-row"><strong>${draft.length} / 10 songs suggested</strong><span>Total ${time(total)}</span></div><ol class="bs-j-slots">${draft.map((id, i) => { const t = view.tracks.find(t => t.id === id); return `<li><b>${String(i + 1).padStart(2, "0")}</b><span>${escape(t?.title ?? "Missing song")}<small>${t ? `${time(t.duration)} · ${t.playable ? "Ready" : t.status}` : "Relink this song"}${draft.indexOf(id) < i ? " · Repeat" : ""}</small></span><div>${button("up", "↑", `data-index="${i}" aria-label="Move song ${i + 1} up" ${i === 0 ? "disabled" : ""}`)}${button("down", "↓", `data-index="${i}" aria-label="Move song ${i + 1} down" ${i === draft.length - 1 ? "disabled" : ""}`)}${button("slot-remove", "×", `data-index="${i}" aria-label="Remove song ${i + 1}"`)}</div></li>`; }).join("")}</ol><div class="bs-j-row"><select id="bs-playlist-add" aria-label="Song to add"><option value="">Choose a library song</option>${view.tracks.map(t => `<option value="${escape(t.id)}">${escape(t.title)} · ${escape(t.status)}</option>`).join("")}</select>${button("add-slot", "Add song")}</div><div class="bs-j-actions">${button("save-playlist", "Save playlist")}${button("start-playlist", "Start campaign", `${!ready || !view.available ? "disabled" : ""}`)}${draftId ? button("delete-playlist", "Delete playlist") : ""}</div>${!ready && draft.length ? "<p>Every song needs audio and usable timing before this run can start.</p>" : ""}</section></div>`
        : tab === "route" ? `
            <div class="bs-journey-heading"><div><p class="bs-j-eyebrow">${view.active ? `STAGE ${Math.min(view.active.songIndex + 1, view.active.total)} OF ${view.active.total}` : "CAMPAIGN"}</p><h1>${escape(view.active?.title ?? "Your next journey")}</h1><p>${view.active ? "Choose your next arena. Your songs stay in playlist order." : "Build a playlist to start a run across your music."}</p></div>${view.active && view.phase !== "map" ? button("continue", "Continue run") : ""}</div>
            ${view.active ? `<div class="bs-j-build"><strong>Level ${view.active.level}</strong><span>${view.active.xp} / ${view.active.requiredXp} XP</span><span>Hull ${view.active.health}</span><span>${time(remaining)} remaining</span><p>${view.active.upgrades.map(escape).join(" · ") || "Choose your starting upgrade"}</p></div><div class="bs-j-route-layout"><ol class="bs-j-route">${view.route?.map((r, i) => `<li data-current="${r.current}" data-completed="${!!r.completed}"><b>${r.completed ? "✓" : String(i + 1).padStart(2, "0")}</b><span>${escape(r.title)}<small>${time(r.duration)}${r.completed ? ` · ${escape(r.completed)}` : ""}</small></span><span class="bs-j-branches" aria-hidden="true">◇ ◇ ◇</span></li>`).join("") ?? ""}</ol><section class="bs-j-arena-list">${view.choices?.length ? `<h2>${escape(nextSong?.title ?? "Next song")}</h2><p>${time(nextSong?.duration)} · ${escape(nextSong?.timing ?? "")} timing</p><p>Full health at entry. Survive until the song ends to clear the stage.</p>${view.choices.map(c => `<button class="bs-j-arena" data-j="select-arena" data-id="${escape(c.id)}" aria-pressed="${selectedArena === c.id}"><span class="bs-j-arena-symbol" data-arena="${escape(c.id)}" aria-hidden="true">${c.id.includes("pulse") ? "▦" : c.id.includes("elite") ? "✦" : c.id.includes("swarm") ? "⋰" : c.id.includes("spinner") ? "✳" : c.id.includes("marksman") ? "⌖" : "◇"}</span><span><small>${escape(c.pressure)}</small><strong>${escape(c.name)}</strong><span>${escape(c.description)}</span><em>${escape(c.reward)}</em></span></button>`).join("")}${button("start-arena", "Enter selected arena", `${!selectedArena ? "disabled" : ""}`)}` : `<p>${view.active.status === "song-active" ? "Resume replays your last started song from its saved entry build." : "Continue your run to choose your next step."}</p>`}</section></div><div class="bs-j-actions">${button("exit-map", "Save & return to menu")}${button("abandon", "Abandon run")}</div><p class="bs-j-note">Song-entry checkpoint · Leaving during a song replays it from the start. Progress from cleared songs is kept.</p>` : button("to-playlists", "Build a playlist")}`
        : `<div class="bs-journey-heading"><div><p class="bs-j-eyebrow">LOCAL STORAGE</p><h1>Save & recovery</h1><p>Your library lives in this browser, on this device and site address.</p></div></div><section class="bs-j-detail"><h2>Keep your progress safe</h2><p>${escape(view.storage)}</p><p>Browser storage can be cleared or evicted. A recovery file contains playlists, timing and run progress. It does not contain audio; keep your original recordings to relink after importing.</p><div class="bs-j-actions">${button("persist", "Request persistent storage")}${button("export", "Export recovery JSON")}<label class="bs-button bs-button-outline" tabindex="0" role="button">Import recovery JSON<input id="bs-recovery-file" type="file" accept="application/json,.json" hidden></label></div></section>`;
        root.innerHTML = `<section class="bs-journey" role="dialog" aria-modal="true" aria-label="Music library and campaign"><header class="bs-j-header"><strong>beatshooter <span> / journey</span></strong><nav aria-label="Music and run navigation">${([['library','Library'],['playlists','Playlists'],['route','Run map'],['recovery','Save & recovery']] as const).map(([id,label]) => `<button data-j="tab" data-id="${id}" aria-current="${tab === id ? "page" : "false"}">${label}</button>`).join("")}</nav>${button("close", "Back to menu")}</header><main class="bs-journey-body">${!view.available ? `<div class="bs-j-alert">${escape(view.storage)} Quick Play and Practice remain available.</div>` : ""}${view.error || localError ? `<div class="bs-j-alert" role="alert">${escape(localError || view.error!)}${view.retrySave ? button("retry-save", "Retry save") + button("reload-save", "Reload saved checkpoint") : ""}</div>` : ""}${view.notice ? `<p class="bs-j-notice" role="status">${escape(view.notice)}</p>` : ""}${view.phase === "settling" && !view.error ? `<p class="bs-j-notice" role="status">Saving stage progress…</p>` : ""}${content}<footer class="bs-j-footer">${escape(view.storage)} · Audio stays on your device.</footer></main>${confirmation ? `<div class="bs-j-confirm" role="alertdialog" aria-modal="true" aria-labelledby="bs-j-confirm-title"><section><h2 id="bs-j-confirm-title">${confirmation === "replace" ? "Replace your active run?" : confirmation === "abandon" ? "Abandon this run?" : confirmation === "recover" ? "Import this recovery file?" : "Delete this item?"}</h2><p>${confirmation === "replace" || confirmation === "abandon" ? "The current campaign ends. Your music library and playlists stay saved." : confirmation === "delete-track" ? "Remove this recording and its timing from the library and all playlists. This cannot be undone." : confirmation === "recover" ? "Matching library metadata and playlists will be restored. Audio is not included. A conflicting active campaign must be abandoned first." : "The playlist will be removed. An active run keeps its own copy."}</p><div class="bs-j-actions">${button("confirm", "Confirm")}${button("cancel-confirm", "Cancel")}</div></section></div>` : ""}</section>`;
        if (disabled) for (const b of root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button,input,select")) b.disabled = true;
        for (const [id, value] of editingValues) {
            const input = root.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`);
            if (input) input.value = value;
        }
        const addSong = root.querySelector<HTMLSelectElement>("#bs-playlist-add");
        if (addSong) addSong.value = songToAdd;
        root.querySelector(".bs-journey-body")!.scrollTop = scroll;
        if (confirmation) {
            root.querySelector<HTMLElement>(".bs-j-header")!.inert = true;
            root.querySelector<HTMLElement>(".bs-journey-body")!.inert = true;
        }
        if (confirmation && !confirmationWasOpen) root.querySelector<HTMLElement>('.bs-j-confirm [data-j="cancel-confirm"]')?.focus();
        else if (focused) {
            const replacement = root.querySelector<HTMLInputElement>(`#${CSS.escape(focused)}`);
            if (replacement && inputValue !== undefined && !force) {
                replacement.value = inputValue;
                if (selectionStart != null && replacement.type === "text") replacement.setSelectionRange(selectionStart, selectionStart);
            }
            replacement?.focus({ preventScroll: true });
        } else if (focusedAction) {
            [...root.querySelectorAll<HTMLElement>("[data-j]")].find(el => el.dataset.j === focusedAction && el.dataset.id === focusedId && el.dataset.index === focusedIndex)?.focus({ preventScroll: true });
        } else if (!root.contains(document.activeElement)) root.querySelector<HTMLElement>('[data-j="tab"]')?.focus({ preventScroll: true });
    };
    root.addEventListener("input", e => { const el = e.target as HTMLInputElement; if (el.id === "bs-playlist-name") draftName = el.value; }, { signal: events.signal });
    root.addEventListener("click", e => {
        const b = (e.target as Element).closest<HTMLButtonElement>("[data-j]");
        if (!b || b.disabled || running || view.busy) return;
        const id = b.dataset.id!, index = Number(b.dataset.index);
        switch (b.dataset.j) {
            case "tab": tab = id as typeof tab; break;
            case "close": case "exit-map": actions.close(); focusBefore?.focus(); return;
            case "detail": detail = id; break;
            case "preview": void execute(() => actions.preview(id)); return;
            case "quick": void execute(() => actions.quickPlay(id)); return;
            case "rename": { const title = root.querySelector<HTMLInputElement>("#bs-library-title")!.value, artist = root.querySelector<HTMLInputElement>("#bs-library-artist")!.value; void execute(() => actions.rename(id, title, artist)); return; }
            case "manual": { const bpm = Number(root.querySelector<HTMLInputElement>("#bs-library-bpm")!.value), offset = Number(root.querySelector<HTMLInputElement>("#bs-library-offset")!.value); void execute(() => actions.manual(id, bpm, offset)); return; }
            case "analyze": void execute(() => actions.analyze(id)); return;
            case "remove": confirmation = "delete-track"; confirmationId = id; break;
            case "new-playlist": draftId = undefined; draftName = "My ten-song run"; draft = []; songToAdd = ""; break;
            case "edit-playlist": { const p = view.playlists.find(p => p.id === id)!; draftId = p.id; draftName = p.name; draft = [...p.trackIds]; break; }
            case "add-slot": { if (songToAdd && draft.length < 50) draft.push(songToAdd); songToAdd = ""; break; }
            case "slot-remove": draft.splice(index, 1); break;
            case "up": case "down": { const dest = index + (b.dataset.j === "up" ? -1 : 1); if (draft[dest] && draft[index]) [draft[index], draft[dest]] = [draft[dest]!, draft[index]!]; break; }
            case "save-playlist": void execute(save); return;
            case "start-playlist": if (view.active) { confirmation = "replace"; break; } void execute(async () => actions.startPlaylist(await save())); return;
            case "delete-playlist": confirmation = "delete-playlist"; confirmationId = draftId; break;
            case "to-playlists": tab = "playlists"; break;
            case "continue": void execute(actions.continue); return;
            case "select-arena": selectedArena = id; break;
            case "start-arena": if (selectedArena) void execute(async () => { await actions.arena(selectedArena!); selectedArena = undefined; }); return;
            case "abandon": confirmation = "abandon"; break;
            case "cancel-confirm": confirmation = undefined; break;
            case "confirm": { const kind = confirmation, target = confirmationId; confirmation = undefined; void execute(async () => { if (kind === "abandon") await actions.abandon(); else if (kind === "replace") { const playlist = await save(); await actions.abandon(); await actions.startPlaylist(playlist); } else if (kind === "delete-track") { await actions.remove(target!); detail = undefined; } else if (kind === "delete-playlist") { await actions.deletePlaylist(target!); draftId = undefined; } else if (kind === "recover" && recoveryFile) await actions.recover(recoveryFile); }); return; }
            case "persist": void execute(actions.persist); return;
            case "export": void execute(actions.export); return;
            case "retry-save": void execute(actions.retrySave); return;
            case "reload-save": void execute(actions.reloadSave); return;
        }
        render(true);
    }, { signal: events.signal });
    root.addEventListener("change", e => {
        const el = e.target as HTMLInputElement;
        if (el.id === "bs-playlist-add") songToAdd = el.value;
        else if (el.id === "bs-library-files" && el.files?.length) { const files = [...el.files]; void execute(() => actions.import(files)); }
        else if (el.id === "bs-library-relink" && el.files?.[0]) { const file = el.files[0]; void execute(() => actions.relink(el.dataset.id!, file)); }
        else if (el.id === "bs-recovery-file" && el.files?.[0]) { recoveryFile = el.files[0]; confirmation = "recover"; render(true); }
    }, { signal: events.signal });
    root.addEventListener("dragover", e => { if (tab === "library") e.preventDefault(); }, { signal: events.signal });
    root.addEventListener("drop", e => { e.preventDefault(); if (tab === "library" && e.dataTransfer?.files.length) { const files = [...e.dataTransfer.files]; void execute(() => actions.import(files)); } }, { signal: events.signal });
    root.addEventListener("keydown", e => {
        const label = (e.target as Element).closest<HTMLLabelElement>('label[role="button"]');
        if (label && (e.code === "Enter" || e.code === "Space")) { e.preventDefault(); label.querySelector<HTMLInputElement>("input")?.click(); return; }
        if (e.code === "Escape") { e.preventDefault(); e.stopPropagation(); if (confirmation) { confirmation = undefined; render(true); } else actions.close(); }
        if (e.code === "Tab") {
            const scope = root.querySelector(".bs-j-confirm") ?? root;
            const els = [...scope.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(e => e.checkVisibility());
            const first = els[0], last = els.at(-1);
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
    }, { signal: events.signal });
    return { render(next: JourneyView) { view = next; render(); }, dispose() { events.abort(); root.remove(); } };
}
