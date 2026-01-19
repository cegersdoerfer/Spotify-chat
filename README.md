# SpotifyFS

Local Folder ↔ Spotify Playlist Sync + Chatbot + Git Branching

SpotifyFS turns Spotify playlist management into a local, inspectable, version-controlled workflow.

## Features

- **Local representation:** Playlists appear as folders; tracks appear as small reference files containing Spotify URIs
- **Two-way sync:** Local edits update Spotify; Spotify edits update the local tree
- **Git integration:** Changes are tracked in Git for version control and review
- **Chatbot proposals:** AI-driven playlist creation as Git branches for review

## Installation

```bash
npm install -g spotifyfs
```

## Prerequisites

1. Create a Spotify app at https://developer.spotify.com/dashboard
2. Set the redirect URI to `http://localhost:8888/callback`
3. Set the `SPOTIFY_CLIENT_ID` environment variable

```bash
export SPOTIFY_CLIENT_ID=your_client_id
```

## Quick Start

```bash
# Initialize a workspace
spotifyfs init ~/Music/SpotifyFS

# Authenticate with Spotify
spotifyfs auth

# Pull your playlists
spotifyfs pull

# Check status
spotifyfs status

# Make local changes, then push
spotifyfs push
```

## Commands

| Command | Description |
|---------|-------------|
| `spotifyfs init [path]` | Initialize a new workspace |
| `spotifyfs auth` | Authenticate with Spotify |
| `spotifyfs pull` | Pull playlists from Spotify |
| `spotifyfs push` | Push local changes to Spotify |
| `spotifyfs status` | Show sync status |
| `spotifyfs diff` | Show differences |
| `spotifyfs watch` | Watch for changes and sync automatically |
| `spotifyfs branch` | Manage Git branches |
| `spotifyfs apply <branch>` | Apply changes from a branch |
| `spotifyfs resolve` | Resolve sync conflicts |
| `spotifyfs chat [prompt]` | Interactive chatbot |

## Workspace Structure

```
SpotifyFS/
  .spotifyfs/
    state.db                # SQLite database
    config.json             # Workspace settings
    tokens.json             # Spotify tokens (encrypted)
    proposals/              # Chatbot proposal metadata
  Playlists/
    My Playlist__<playlist_id>/
      playlist.json         # Playlist metadata
      tracks/
        001__Artist - Track__<track_id>.spotify
        002__...
```

## Chatbot Examples

```bash
# Create a playlist
spotifyfs chat "Create a chill bossa nova playlist from my saved songs"

# The chatbot creates changes on a new branch
# Review with:
spotifyfs branch diff bot/bossa-nova-2026-01-19

# Apply the changes
spotifyfs apply bot/bossa-nova-2026-01-19 --merge --delete
```

## Configuration

Edit `.spotifyfs/config.json`:

```json
{
  "version": "1.0.0",
  "settings": {
    "pullInterval": 300000,
    "autoCommit": true,
    "orderingMode": "prefix",
    "syncLibrary": false,
    "conflictPolicy": "prompt"
  }
}
```

### Settings

- **pullInterval**: Polling interval for remote changes (ms)
- **autoCommit**: Auto-commit after pull/push operations
- **orderingMode**: Track ordering (`prefix` or `orderfile`)
- **syncLibrary**: Sync liked/saved tracks
- **conflictPolicy**: Conflict resolution (`prompt`, `take-local`, `take-remote`)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run in development mode
npm run dev -- init ./test-workspace
```

## License

MIT
