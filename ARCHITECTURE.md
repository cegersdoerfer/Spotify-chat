# SpotifyFS Architecture Documentation

## Overview

SpotifyFS is a CLI tool that synchronizes Spotify playlists with a local SQLite database, enabling version-controlled playlist management with Git integration and AI-powered playlist creation.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SpotifyFS                                       │
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   Spotify   │◄──►│    Sync     │◄──►│   SQLite    │◄──►│     Git     │  │
│  │     API     │    │   Engine    │    │  + Markdown │    │   Manager   │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘  │
│         ▲                  ▲                  ▲                  ▲          │
│         │                  │                  │                  │          │
│         └──────────────────┴────────┬─────────┴──────────────────┘          │
│                                     │                                        │
│                              ┌──────┴──────┐                                │
│                              │     CLI     │                                │
│                              │  Commands   │                                │
│                              └──────┬──────┘                                │
│                                     │                                        │
│                              ┌──────┴──────┐                                │
│                              │   Chatbot   │◄────► GPT-5 (OpenAI)           │
│                              │ Orchestrator│                                │
│                              └─────────────┘                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

## System Components

### 1. CLI Layer (`src/cli/`)

The command-line interface that users interact with.

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Commands                             │
├─────────────┬─────────────┬─────────────┬─────────────┬─────────┤
│    init     │    auth     │    pull     │    push     │  status │
├─────────────┼─────────────┼─────────────┼─────────────┼─────────┤
│    diff     │   watch     │   branch    │   apply     │ resolve │
├─────────────┴─────────────┴─────────────┴─────────────┴─────────┤
│                           chat                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Command Flow:**

```
User Input
    │
    ▼
┌─────────────────┐
│  CLI Command    │
│    Parser       │
│  (Commander)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Create Context │
│  - Config       │
│  - StateStore   │
│  - SpotifyClient│
│  - LibraryDB    │
│  - Markdown Gen │
│  - SyncEngine   │
│  - GitManager   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Execute Command │
└────────┬────────┘
         │
         ▼
    CLI Output
```

### 2. Spotify API Client (`src/spotify/`)

Handles all communication with the Spotify Web API.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Spotify Client                              │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Authentication                         │   │
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │   │
│  │  │    PKCE     │───►│   Token     │───►│   Token     │   │   │
│  │  │   Flow      │    │  Exchange   │    │   Refresh   │   │   │
│  │  └─────────────┘    └─────────────┘    └─────────────┘   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    API Operations                         │   │
│  │                                                           │   │
│  │  Playlists:          Tracks:            User:            │   │
│  │  • List all          • Search           • Get profile    │   │
│  │  • Get details       • Get details      • Get saved      │   │
│  │  • Create            • Get features                      │   │
│  │  • Update            • Batch get                         │   │
│  │  • Add tracks                                            │   │
│  │  • Remove tracks                                         │   │
│  │  • Replace tracks                                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Rate Limiting                          │   │
│  │           429 Handling + Retry-After + Backoff           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**OAuth PKCE Flow:**

```
┌────────┐                              ┌─────────┐                    ┌─────────┐
│  User  │                              │SpotifyFS│                    │ Spotify │
└───┬────┘                              └────┬────┘                    └────┬────┘
    │                                        │                              │
    │  1. spotifyfs auth                     │                              │
    │───────────────────────────────────────►│                              │
    │                                        │                              │
    │                                        │ 2. Generate code_verifier    │
    │                                        │    + code_challenge          │
    │                                        │                              │
    │  3. Open browser                       │                              │
    │◄───────────────────────────────────────│                              │
    │                                        │                              │
    │  4. Login + Authorize                  │                              │
    │───────────────────────────────────────────────────────────────────────►
    │                                        │                              │
    │  5. Redirect with code                 │                              │
    │◄──────────────────────────────────────────────────────────────────────│
    │                                        │                              │
    │  6. Code sent to localhost:8888        │                              │
    │───────────────────────────────────────►│                              │
    │                                        │                              │
    │                                        │ 7. Exchange code + verifier  │
    │                                        │────────────────────────────►│
    │                                        │                              │
    │                                        │ 8. Access + Refresh tokens   │
    │                                        │◄────────────────────────────│
    │                                        │                              │
    │  9. Auth complete!                     │                              │
    │◄───────────────────────────────────────│                              │
```

### 3. Storage Layer (`src/state/`)

Two SQLite databases for state management and library storage.

```
┌─────────────────────────────────────────────────────────────────┐
│                    State Database (state.db)                     │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                   playlist_mappings                         │ │
│  │  ┌────────────┬────────────┬────────────┬────────────────┐ │ │
│  │  │playlist_id │ local_path │snapshot_id │ last_synced_at │ │ │
│  │  │ (PK)       │            │            │                │ │ │
│  │  └────────────┴────────────┴────────────┴────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      sync_log                               │ │
│  │  ┌────┬───────────┬────────────┬─────────┬───────────────┐ │ │
│  │  │ id │ timestamp │ operation  │ success │ error_message │ │ │
│  │  └────┴───────────┴────────────┴─────────┴───────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      proposals                              │ │
│  │  ┌────┬─────────────┬─────────────┬────────┬────────────┐  │ │
│  │  │ id │ branch_name │ user_prompt │ status │ metadata   │  │ │
│  │  └────┴─────────────┴─────────────┴────────┴────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     tombstones                              │ │
│  │  ┌─────────────┬───────────┬─────────────┐                 │ │
│  │  │ entity_type │ entity_id │ deleted_at  │                 │ │
│  │  └─────────────┴───────────┴─────────────┘                 │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                  Library Database (library.db)                   │
│              (Source of truth for playlist data)                │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      playlists                              │ │
│  │  ┌────┬──────┬─────────────┬───────────┬─────────────────┐ │ │
│  │  │ id │ name │ description │ owner_id  │ last_synced_at  │ │ │
│  │  │(PK)│      │             │           │                 │ │ │
│  │  └────┴──────┴─────────────┴───────────┴─────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                       tracks                                │ │
│  │  ┌────┬──────┬─────────┬───────┬─────────────┬───────────┐ │ │
│  │  │ id │ name │ artists │ album │ duration_ms │    uri    │ │ │
│  │  │(PK)│      │ (JSON)  │       │             │           │ │ │
│  │  └────┴──────┴─────────┴───────┴─────────────┴───────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                   playlist_tracks                           │ │
│  │  ┌─────────────┬──────────┬──────────┬──────────────────┐  │ │
│  │  │ playlist_id │ track_id │ position │    added_at      │  │ │
│  │  │    (PK)     │   (PK)   │          │                  │  │ │
│  │  └─────────────┴──────────┴──────────┴──────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**SQL Operations for LLM:**

The chatbot can query and modify the library database using SQL:

```sql
-- Example queries the LLM can execute:

-- Find all tracks by an artist
SELECT * FROM tracks WHERE artists LIKE '%Taylor Swift%';

-- Get tracks in a playlist ordered by position
SELECT t.* FROM tracks t
JOIN playlist_tracks pt ON t.id = pt.track_id
WHERE pt.playlist_id = 'abc123'
ORDER BY pt.position;

-- Find duplicate tracks across playlists
SELECT track_id, COUNT(*) as count
FROM playlist_tracks
GROUP BY track_id HAVING count > 1;

-- Move tracks between playlists (via DELETE + INSERT)
DELETE FROM playlist_tracks WHERE playlist_id = 'source' AND track_id = 'xyz';
INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('dest', 'xyz', 1);
```

### 4. Markdown Layer (`src/filesystem/`)

Generates human-readable markdown files from SQLite for meaningful Git diffs.

**Workspace Structure:**

```
SpotifyFS/
│
├── .spotifyfs/
│   ├── state.db              # Sync state database
│   ├── library.db            # Playlist/track data (source of truth)
│   ├── config.json           # Workspace configuration
│   ├── tokens.json           # Spotify OAuth tokens (secured)
│   └── proposals/            # Chatbot proposal metadata
│       └── <id>.json
│
├── Playlists/                # Generated markdown (for Git diffs)
│   ├── My Playlist.md
│   ├── Another Playlist.md
│   └── ...
│
├── .git/                     # Git repository
├── .gitignore
└── README.md
```

**Markdown Format:**

```markdown
# My Awesome Playlist

**ID:** 37i9dQZF1DX...
**Owner:** username
**Tracks:** 42
**Last Synced:** 2026-01-20

## Tracks

| # | Title | Artist | Album | Duration |
|---|-------|--------|-------|----------|
| 1 | Song Name | Artist Name | Album Name | 3:45 |
| 2 | Another Song | Another Artist | Another Album | 4:12 |
| ... | ... | ... | ... | ... |
```

This format provides:
- Human-readable playlist representation
- Meaningful Git diffs when tracks are added/removed/reordered
- Easy review of chatbot-proposed changes

### 5. Sync Engine (`src/sync/`)

Handles bidirectional synchronization between SQLite and Spotify.

**Sync Flow:**

```
                            ┌─────────────┐
                            │  Sync Start │
                            └──────┬──────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                              ▼
            ┌───────────────┐              ┌───────────────┐
            │  Fetch Remote │              │  Read SQLite  │
            │   Playlists   │              │    Library    │
            └───────┬───────┘              └───────┬───────┘
                    │                              │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                         ┌─────────────────┐
                         │  Compute Diff   │
                         │                 │
                         │ • Additions     │
                         │ • Removals      │
                         │ • Reorders      │
                         │ • Conflicts     │
                         └────────┬────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │      Has Conflicts?       │
                    └─────────────┬─────────────┘
                           │             │
                      No   │             │  Yes
                           ▼             ▼
                  ┌─────────────┐  ┌─────────────┐
                  │   Apply     │  │  Resolve    │
                  │   Changes   │  │  Conflicts  │
                  └──────┬──────┘  └──────┬──────┘
                         │                │
                         └────────┬───────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │ Update SQLite   │
                         │ Generate Markdown│
                         │ Update State    │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │  Git Commit     │
                         │  (if enabled)   │
                         └─────────────────┘
```

**Pull Operation:**
1. Fetch all playlists from Spotify API
2. Import each playlist into SQLite (`library.db`)
3. Generate markdown files from SQLite
4. Update state mappings in `state.db`
5. Git commit the markdown changes

**Push Operation:**
1. Read playlists from SQLite
2. Compare with remote Spotify state
3. Apply changes to Spotify API
4. Update SQLite with new snapshot IDs
5. Regenerate markdown files

### 6. Git Manager (`src/git/`)

Integrates with Git for version control.

**Branch Strategy:**

```
                           main
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
   bot/chill-vibes    bot/workout-mix      conflict/playlist-123
   (chatbot proposal) (chatbot proposal)   (conflict snapshot)
        │                    │
        │   Review & Apply   │
        │                    │
        └────────┬───────────┘
                 │
                 ▼
           Merge to main
           Push to Spotify
```

### 7. Chatbot Orchestrator (`src/chatbot/`)

AI-powered playlist management using GPT-5 with SQL capabilities.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chatbot Orchestrator                          │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                      User Prompt                           │  │
│  │      "Move all jazz tracks to my Jazz Favorites playlist" │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│                            ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                Library Context Builder                     │  │
│  │                                                            │  │
│  │  • Database schema documentation                           │  │
│  │  • Library stats (playlists, tracks, etc.)                │  │
│  │  • Playlist summary table                                  │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│                            ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   Planner (GPT-5)                          │  │
│  │                                                            │  │
│  │  Input:                                                    │  │
│  │  • User prompt                                             │  │
│  │  • Database schema                                         │  │
│  │  • Available step types (including SQL)                    │  │
│  │  • Current library state                                   │  │
│  │                                                            │  │
│  │  Output (JSON):                                            │  │
│  │  {                                                         │  │
│  │    "plan": {                                               │  │
│  │      "intent": "Move jazz tracks",                         │  │
│  │      "steps": [                                            │  │
│  │        { "type": "sql_query", "query": "SELECT..." },     │  │
│  │        { "type": "move_tracks", ... },                    │  │
│  │        { "type": "generate_markdown" },                   │  │
│  │        { "type": "commit_changes", ... }                  │  │
│  │      ]                                                     │  │
│  │    },                                                      │  │
│  │    "confidence": 0.92                                      │  │
│  │  }                                                         │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│                            ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                 Executor (Deterministic)                   │  │
│  │                                                            │  │
│  │  Executes plan steps against:                              │  │
│  │  • SQLite database (query/execute)                         │  │
│  │  • Spotify API (search, fetch)                             │  │
│  │  • Git (branch, commit)                                    │  │
│  │  • Markdown generator                                      │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Available Plan Steps:**

```
┌─────────────────────────────────────────────────────────────────┐
│                     Plan Step Types                              │
├─────────────────┬───────────────────────────────────────────────┤
│  SQL Operations                                                  │
├─────────────────┼───────────────────────────────────────────────┤
│ sql_query       │ Execute SELECT query on library database      │
│ sql_execute     │ Execute INSERT/UPDATE/DELETE on library DB    │
├─────────────────┼───────────────────────────────────────────────┤
│  Spotify API Operations                                          │
├─────────────────┼───────────────────────────────────────────────┤
│ search_tracks   │ Search Spotify for tracks by query            │
│ list_playlists  │ Get all user playlists from Spotify           │
│ fetch_playlist  │ Get tracks from a specific playlist           │
│ fetch_saved     │ Get user's liked/saved tracks                 │
│ filter_tracks   │ Filter collected tracks by criteria           │
├─────────────────┼───────────────────────────────────────────────┤
│  Playlist Operations                                             │
├─────────────────┼───────────────────────────────────────────────┤
│ create_playlist │ Create a new playlist in database             │
│ delete_playlist │ Delete a playlist from database               │
│ rename_playlist │ Rename a playlist                             │
│ add_tracks      │ Add tracks to existing playlist               │
│ remove_tracks   │ Remove tracks from playlist                   │
│ move_tracks     │ Move tracks between playlists                 │
│ reorder_tracks  │ Reorder tracks within a playlist              │
├─────────────────┼───────────────────────────────────────────────┤
│  Git Operations                                                  │
├─────────────────┼───────────────────────────────────────────────┤
│ create_branch   │ Create Git branch for changes                 │
│ commit_changes  │ Commit changes to Git                         │
├─────────────────┼───────────────────────────────────────────────┤
│  Sync Operations                                                 │
├─────────────────┼───────────────────────────────────────────────┤
│ sync_to_spotify │ Push local changes to Spotify                 │
│ generate_markdown│ Regenerate markdown from database            │
└─────────────────┴───────────────────────────────────────────────┘
```

## Data Flow Diagrams

### Pull Operation

```
┌─────────┐         ┌─────────┐         ┌─────────┐         ┌─────────┐
│ Spotify │         │  Sync   │         │ SQLite  │         │Markdown │
│   API   │         │ Engine  │         │ Library │         │Generator│
└────┬────┘         └────┬────┘         └────┬────┘         └────┬────┘
     │                   │                   │                   │
     │ ◄─── Get all ─────│                   │                   │
     │      playlists    │                   │                   │
     │                   │                   │                   │
     │ ─── Playlists ───►│                   │                   │
     │                   │                   │                   │
     │ ◄─── Get tracks ──│                   │                   │
     │      per playlist │                   │                   │
     │                   │                   │                   │
     │ ──── Tracks ─────►│                   │                   │
     │                   │                   │                   │
     │                   │ ── Import ───────►│                   │
     │                   │    playlists      │                   │
     │                   │                   │                   │
     │                   │ ── Generate ──────────────────────────►
     │                   │    markdown       │                   │
     │                   │                   │                   │
     │                   │                   │ ─── .md files ───►│
     │                   │                   │                   │
```

### Push Operation

```
┌─────────┐         ┌─────────┐         ┌─────────┐         ┌─────────┐
│ SQLite  │         │  Sync   │         │ Spotify │         │Markdown │
│ Library │         │ Engine  │         │   API   │         │Generator│
└────┬────┘         └────┬────┘         └────┬────┘         └────┬────┘
     │                   │                   │                   │
     │ ◄── Read local ───│                   │                   │
     │     playlists     │                   │                   │
     │                   │                   │                   │
     │ ── Playlist data ►│                   │                   │
     │                   │                   │                   │
     │                   │ ── Get remote ───►│                   │
     │                   │    playlists      │                   │
     │                   │                   │                   │
     │                   │ ◄─ Remote data ───│                   │
     │                   │                   │                   │
     │                   │ [Compute diff]    │                   │
     │                   │                   │                   │
     │                   │ ── Create/Update ►│                   │
     │                   │    playlists      │                   │
     │                   │                   │                   │
     │ ◄─── Update ──────│                   │                   │
     │      snapshots    │                   │                   │
     │                   │                   │                   │
     │                   │ ── Regenerate ────────────────────────►
     │                   │    markdown       │                   │
     │                   │                   │                   │
```

### Chatbot Operation

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  User   │    │Orchestr-│    │ Planner │    │Executor │    │ SQLite  │
│         │    │  ator   │    │ (GPT-5) │    │         │    │ Library │
└────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘
     │              │              │              │              │
     │ ─ Prompt ───►│              │              │              │
     │              │              │              │              │
     │              │ ─ Build ─────────────────────────────────►│
     │              │   context    │              │              │
     │              │              │              │              │
     │              │ ◄─ Schema + ─────────────────────────────│
     │              │   stats      │              │              │
     │              │              │              │              │
     │              │ ─ Generate ─►│              │              │
     │              │    plan      │              │              │
     │              │              │              │              │
     │              │              │ [Call GPT-5] │              │
     │              │              │              │              │
     │              │ ◄─ Plan ─────│              │              │
     │              │              │              │              │
     │              │ ─ Execute ──────────────────►              │
     │              │    steps     │              │              │
     │              │              │              │              │
     │              │              │              │ ─ SQL query ►│
     │              │              │              │              │
     │              │              │              │ ◄─ Results ──│
     │              │              │              │              │
     │              │              │              │ ─ SQL exec ─►│
     │              │              │              │   (modify)   │
     │              │              │              │              │
     │              │ ◄─ Result ───────────────────              │
     │              │              │              │              │
     │ ◄─ Summary ──│              │              │              │
     │              │              │              │              │
```

## Type System

### Core Types

```typescript
// Spotify entities
SpotifyTrack       { id, uri, name, artists[], album, durationMs }
SpotifyPlaylist    { id, uri, name, description, isPublic, snapshotId, owner }

// Database types
DbPlaylist         { id, name, description, track_count, last_synced_at, ... }
DbTrack            { id, name, artists (JSON), album, duration_ms, uri }
DbPlaylistTrack    { playlist_id, track_id, position, added_at }

// Sync types
PlaylistDiff       { additions[], removals[], reorderNeeded, hasConflict }
SyncOperation      { type, playlistId?, trackIds?, ... }
SyncResult         { success, appliedOperations[], failedOperations[] }

// Chatbot types
PlanStep           { type: 'sql_query' | 'sql_execute' | 'create_playlist' | ... }
LibraryContext     { schema, stats, playlistSummary }
ChatbotPlan        { intent, steps[], estimatedChanges }
ProposalMetadata   { id, branchName, userPrompt, summary, changes }
```

## Error Handling

```
┌─────────────────────────────────────────────────────────────────┐
│                      Error Handling Strategy                     │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    API Errors                            │    │
│  │  • Rate limiting (429) → Retry with backoff              │    │
│  │  • Auth errors (401)   → Refresh token                   │    │
│  │  • Not found (404)     → Log and skip                    │    │
│  │  • Server errors (5xx) → Retry with backoff              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   Sync Conflicts                         │    │
│  │  • Detect via snapshot comparison                        │    │
│  │  • Options: take-local, take-remote, abort               │    │
│  │  • Create conflict branch for manual resolution          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   SQL Safety                             │    │
│  │  • query() only allows SELECT                            │    │
│  │  • execute() only allows INSERT/UPDATE/DELETE            │    │
│  │  • DROP, ALTER, TRUNCATE are blocked                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   LLM Failures                           │    │
│  │  • Low confidence → Return helpful error message         │    │
│  │  • API failure → Log and return error                    │    │
│  │  • Invalid plan → Validation before execution            │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Configuration

```json
{
  "version": "1.0.0",
  "spotifyUserId": "user123",
  "workspacePath": "/path/to/workspace",
  "createdAt": "2026-01-19T00:00:00Z",
  "settings": {
    "pullInterval": 300000,      // Remote polling interval (ms)
    "autoCommit": true,          // Auto-commit after sync
    "syncLibrary": false,        // Sync liked tracks
    "conflictPolicy": "prompt"   // "prompt", "take-local", "take-remote"
  }
}
```

## Security Considerations

```
┌─────────────────────────────────────────────────────────────────┐
│                        Security                                  │
│                                                                  │
│  • OAuth tokens stored with restricted permissions (0600)        │
│  • Tokens file excluded from Git via .gitignore                  │
│  • PKCE flow prevents authorization code interception            │
│  • API keys read from environment variables                      │
│  • SQL operations sanitized (no DROP/ALTER/TRUNCATE)             │
│  • No audio data downloaded or stored                            │
│  • Only playlist/track metadata synced                           │
└─────────────────────────────────────────────────────────────────┘
```
