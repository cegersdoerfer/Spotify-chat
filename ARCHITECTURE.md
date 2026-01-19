# SpotifyFS Architecture Documentation

## Overview

SpotifyFS is a CLI tool that synchronizes Spotify playlists with a local filesystem, enabling version-controlled playlist management with Git integration and AI-powered playlist creation.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SpotifyFS                                       │
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   Spotify   │◄──►│    Sync     │◄──►│ Filesystem  │◄──►│     Git     │  │
│  │     API     │    │   Engine    │    │    Layer    │    │   Manager   │  │
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
│  - Serializer   │
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

### 3. State Store (`src/state/`)

SQLite database for persisting sync state and mappings.

```
┌─────────────────────────────────────────────────────────────────┐
│                        SQLite Database                           │
│                        (state.db)                                │
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
```

### 4. Filesystem Layer (`src/filesystem/`)

Manages the local representation of playlists as folders and tracks as files.

**Workspace Structure:**

```
SpotifyFS/
│
├── .spotifyfs/
│   ├── state.db              # SQLite database
│   ├── config.json           # Workspace configuration
│   ├── tokens.json           # Spotify OAuth tokens (secured)
│   ├── logs/                 # Sync operation logs
│   └── proposals/            # Chatbot proposal metadata
│       └── <id>.json
│
├── Playlists/
│   ├── My Playlist__<playlist_id>/
│   │   ├── playlist.json     # Playlist metadata
│   │   └── tracks/
│   │       ├── 001__Artist - Song__<track_id>.spotify
│   │       ├── 002__Artist - Song__<track_id>.spotify
│   │       └── ...
│   │
│   └── Another Playlist__<playlist_id>/
│       ├── playlist.json
│       └── tracks/
│           └── ...
│
├── .git/                     # Git repository
├── .gitignore
└── README.md
```

**File Formats:**

```
┌─────────────────────────────────────────────────────────────────┐
│  playlist.json                                                   │
├─────────────────────────────────────────────────────────────────┤
│  {                                                               │
│    "id": "37i9dQZF1DX...",                                      │
│    "uri": "spotify:playlist:37i9dQZF1DX...",                    │
│    "name": "My Playlist",                                        │
│    "description": "A great playlist",                            │
│    "isPublic": false,                                            │
│    "collaborative": false,                                       │
│    "snapshotId": "MTY3...",                                      │
│    "owner": { "id": "user123", "displayName": "User" },         │
│    "lastSyncedAt": "2026-01-19T12:00:00Z"                       │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  001__Artist - Track Name__4iV5W9uYEdYUVa79Axb7Rh.spotify       │
├─────────────────────────────────────────────────────────────────┤
│  spotify:track:4iV5W9uYEdYUVa79Axb7Rh                           │
└─────────────────────────────────────────────────────────────────┘
     │         │                    │                    │
     │         │                    │                    └─ File extension
     │         │                    └─ Track ID (source of truth)
     │         └─ Display name (human-readable)
     └─ Position (for ordering)
```

### 5. Sync Engine (`src/sync/`)

Handles bidirectional synchronization between local and Spotify.

**Sync Flow:**

```
                            ┌─────────────┐
                            │  Sync Start │
                            └──────┬──────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                              ▼
            ┌───────────────┐              ┌───────────────┐
            │  Fetch Remote │              │  Read Local   │
            │   Playlists   │              │   Playlists   │
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
                         │  Update State   │
                         │  • Mappings     │
                         │  • Snapshots    │
                         │  • Sync Log     │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │  Git Commit     │
                         │  (if enabled)   │
                         └─────────────────┘
```

**Diff Computation:**

```
┌─────────────────────────────────────────────────────────────────┐
│                      Playlist Diff                               │
│                                                                  │
│   Local Tracks: [A, B, C, D, E]     Remote Tracks: [A, B, F, G] │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    Comparison                            │   │
│   │                                                          │   │
│   │   Common:    [A, B]     (in both)                       │   │
│   │   Additions: [C, D, E]  (local only → add to Spotify)   │   │
│   │   Removals:  [F, G]     (remote only → remove locally)  │   │
│   │   Reorder:   Check if common tracks are in same order   │   │
│   │                                                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                  Conflict Detection                      │   │
│   │                                                          │   │
│   │   Conflict occurs when:                                  │   │
│   │   • Remote snapshot changed since last sync              │   │
│   │   • AND local track hash changed since last sync         │   │
│   │                                                          │   │
│   └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

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

**Commit Workflow:**

```
┌─────────────────────────────────────────────────────────────────┐
│                        Git Operations                            │
│                                                                  │
│   Pull from Spotify:                                             │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│   │ Fetch remote│───►│Write to disk│───►│ Auto-commit │        │
│   │  playlists  │    │   files     │    │  changes    │        │
│   └─────────────┘    └─────────────┘    └─────────────┘        │
│                                                                  │
│   Push to Spotify:                                               │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│   │Check working│───►│   Compute   │───►│   Apply to  │        │
│   │ tree clean  │    │    diff     │    │   Spotify   │        │
│   └─────────────┘    └─────────────┘    └─────────────┘        │
│                                                                  │
│   Chatbot Proposal:                                              │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐        │
│   │Create branch│───►│Make changes │───►│Commit with  │        │
│   │  bot/...    │    │  locally    │    │  metadata   │        │
│   └─────────────┘    └─────────────┘    └─────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### 7. Chatbot Orchestrator (`src/chatbot/`)

AI-powered playlist management using GPT-5.

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chatbot Orchestrator                          │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                      User Prompt                           │  │
│  │         "Create a chill bossa nova playlist"              │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│                            ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   Planner (GPT-5)                          │  │
│  │                                                            │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │                  System Prompt                       │  │  │
│  │  │  • Available step types                              │  │  │
│  │  │  • Planning guidelines                               │  │  │
│  │  │  • Existing playlists context                        │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  │                          │                                 │  │
│  │                          ▼                                 │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │              JSON Structured Output                  │  │  │
│  │  │  {                                                   │  │  │
│  │  │    "plan": { "intent": "...", "steps": [...] },     │  │  │
│  │  │    "confidence": 0.95,                               │  │  │
│  │  │    "interpretation": "..."                           │  │  │
│  │  │  }                                                   │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│                            ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                 Executor (Deterministic)                   │  │
│  │                                                            │  │
│  │  Step 1: create_branch "bossa-nova-mix"                   │  │
│  │       │                                                    │  │
│  │       ▼                                                    │  │
│  │  Step 2: fetch_saved_tracks (limit: 500)                  │  │
│  │       │                                                    │  │
│  │       ▼                                                    │  │
│  │  Step 3: search_tracks "bossa nova" (limit: 100)          │  │
│  │       │                                                    │  │
│  │       ▼                                                    │  │
│  │  Step 4: filter_tracks (keywords: ["bossa", "brazilian"]) │  │
│  │       │                                                    │  │
│  │       ▼                                                    │  │
│  │  Step 5: create_playlist "Bossa Nova Mix"                 │  │
│  │       │                                                    │  │
│  │       ▼                                                    │  │
│  │  Step 6: commit_changes "Create playlist: Bossa Nova Mix" │  │
│  │                                                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                            │                                     │
│                            ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                        Result                              │  │
│  │  • Branch: bot/bossa-nova-mix-2026-01-19                  │  │
│  │  • Changes: 1 playlist created, 47 tracks added           │  │
│  │  • Status: Ready for review                                │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Available Plan Steps:**

```
┌─────────────────────────────────────────────────────────────────┐
│                     Plan Step Types                              │
├─────────────────┬───────────────────────────────────────────────┤
│ search_tracks   │ Search Spotify for tracks by query            │
│ list_playlists  │ Get all user playlists (read-only)            │
│ fetch_playlist  │ Get tracks from a specific playlist           │
│ fetch_saved     │ Get user's liked/saved tracks                 │
│ filter_tracks   │ Filter collected tracks by criteria           │
│ create_playlist │ Create a new playlist locally                 │
│ add_tracks      │ Add tracks to existing playlist               │
│ remove_tracks   │ Remove tracks from playlist                   │
│ create_branch   │ Create Git branch for changes                 │
│ commit_changes  │ Commit changes to Git                         │
└─────────────────┴───────────────────────────────────────────────┘
```

## Data Flow Diagrams

### Pull Operation

```
┌─────────┐         ┌─────────┐         ┌─────────┐         ┌─────────┐
│ Spotify │         │  Sync   │         │Filesys- │         │  State  │
│   API   │         │ Engine  │         │  tem    │         │  Store  │
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
     │                   │ ── Read local ───►│                   │
     │                   │    playlists      │                   │
     │                   │                   │                   │
     │                   │ ◄─ Local data ────│                   │
     │                   │                   │                   │
     │                   │ ─── Get last ─────────────────────────►
     │                   │     sync state    │                   │
     │                   │                   │                   │
     │                   │ ◄── State data ───────────────────────│
     │                   │                   │                   │
     │                   │ [Compute diff]    │                   │
     │                   │                   │                   │
     │                   │ ── Write new ────►│                   │
     │                   │    playlists      │                   │
     │                   │                   │                   │
     │                   │ ── Update ────────────────────────────►
     │                   │    mappings       │                   │
     │                   │                   │                   │
```

### Push Operation

```
┌─────────┐         ┌─────────┐         ┌─────────┐         ┌─────────┐
│Filesys- │         │  Sync   │         │ Spotify │         │  State  │
│  tem    │         │ Engine  │         │   API   │         │  Store  │
└────┬────┘         └────┬────┘         └────┬────┘         └────┬────┘
     │                   │                   │                   │
     │ ◄── Read local ───│                   │                   │
     │     playlists     │                   │                   │
     │                   │                   │                   │
     │ ── Local data ───►│                   │                   │
     │                   │                   │                   │
     │                   │ ── Get remote ───►│                   │
     │                   │    playlists      │                   │
     │                   │                   │                   │
     │                   │ ◄─ Remote data ───│                   │
     │                   │                   │                   │
     │                   │ ◄── Get sync ─────────────────────────│
     │                   │     context       │                   │
     │                   │                   │                   │
     │                   │ [Compute diff]    │                   │
     │                   │ [Check conflicts] │                   │
     │                   │                   │                   │
     │                   │ ── Add tracks ───►│                   │
     │                   │                   │                   │
     │                   │ ── Remove trks ──►│                   │
     │                   │                   │                   │
     │                   │ ── Reorder ──────►│                   │
     │                   │                   │                   │
     │                   │ ── Update ────────────────────────────►
     │                   │    state          │                   │
     │                   │                   │                   │
```

### Chatbot Operation

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  User   │    │Orchestr-│    │ Planner │    │Executor │    │  Git    │
│         │    │  ator   │    │ (GPT-5) │    │         │    │ Manager │
└────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘    └────┬────┘
     │              │              │              │              │
     │ ─ Prompt ───►│              │              │              │
     │              │              │              │              │
     │              │ ─ Generate ─►│              │              │
     │              │    plan      │              │              │
     │              │              │              │              │
     │              │              │ [Call GPT-5] │              │
     │              │              │              │              │
     │              │ ◄─ Plan ─────│              │              │
     │              │    + conf.   │              │              │
     │              │              │              │              │
     │              │ ─ Execute ──────────────────►              │
     │              │    steps     │              │              │
     │              │              │              │              │
     │              │              │              │ ─ Create ────►
     │              │              │              │   branch     │
     │              │              │              │              │
     │              │              │              │ [Fetch tracks]
     │              │              │              │ [Filter]     │
     │              │              │              │ [Create playlist]
     │              │              │              │              │
     │              │              │              │ ─ Commit ────►
     │              │              │              │   changes    │
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

// Local representation
LocalTrackRef      { trackId, uri, displayName, position, filePath }
LocalPlaylist      { playlistId, name, folderPath, tracks[], metadata }

// Sync types
PlaylistDiff       { additions[], removals[], reorderNeeded, hasConflict }
SyncOperation      { type, playlistId?, trackIds?, ... }
SyncPlan           { operations[], conflicts[] }
SyncResult         { success, appliedOperations[], failedOperations[] }

// Chatbot types
PlanStep           { type, ...params }
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
│  │  • Options: take-local, take-remote, interactive         │    │
│  │  • Create conflict branch for manual resolution          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   LLM Failures                           │    │
│  │  • Fallback to simple rule-based plan                    │    │
│  │  • Return low confidence score                           │    │
│  │  • Log error for debugging                               │    │
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
    "orderingMode": "prefix",    // "prefix" or "orderfile"
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
│  • No audio data downloaded or stored                            │
│  • Only playlist/track metadata synced                           │
└─────────────────────────────────────────────────────────────────┘
```
