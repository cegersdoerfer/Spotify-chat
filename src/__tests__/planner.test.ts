import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatbotPlanner } from '../chatbot/planner.js';

// Mock the OpenAI SDK
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    })),
  };
});

describe('ChatbotPlanner', () => {
  let planner: ChatbotPlanner;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Get the mocked OpenAI
    const OpenAI = (await import('openai')).default;
    planner = new ChatbotPlanner('test-api-key');

    // Access the mock
    mockCreate = (planner as unknown as { openai: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).openai.chat.completions.create;
  });

  describe('generatePlan', () => {
    it('should generate plan for creating a playlist', async () => {
      const mockResponse = {
        plan: {
          intent: 'create_playlist',
          steps: [
            { type: 'create_branch', name: 'chill-vibes' },
            { type: 'search_tracks', query: 'chill relaxing', limit: 100 },
            { type: 'fetch_saved_tracks', limit: 200 },
            { type: 'filter_tracks', criteria: { keywords: ['chill', 'relaxing', 'calm'] } },
            { type: 'create_playlist', name: 'Chill Vibes' },
            { type: 'commit_changes', message: 'Create playlist: Chill Vibes' },
          ],
          estimatedChanges: {
            playlistsCreated: 1,
            playlistsModified: 0,
            tracksAdded: 50,
            tracksRemoved: 0,
          },
        },
        confidence: 0.95,
        interpretation: 'Creating a new chill playlist with relaxing tracks from your library and Spotify search',
      };

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      });

      const result = await planner.generatePlan('Create a chill playlist', []);

      expect(result.plan.intent).toBe('create_playlist');
      expect(result.plan.steps.length).toBeGreaterThan(0);
      expect(result.plan.steps.some((s) => s.type === 'create_playlist')).toBe(true);
      expect(result.plan.steps.some((s) => s.type === 'create_branch')).toBe(true);
      expect(result.confidence).toBe(0.95);
    });

    it('should call OpenAI with correct parameters', async () => {
      const mockResponse = {
        plan: {
          intent: 'create_playlist',
          steps: [
            { type: 'create_branch', name: 'test' },
            { type: 'create_playlist', name: 'Test' },
            { type: 'commit_changes', message: 'Create playlist' },
          ],
          estimatedChanges: {
            playlistsCreated: 1,
            playlistsModified: 0,
            tracksAdded: 0,
            tracksRemoved: 0,
          },
        },
        confidence: 0.9,
        interpretation: 'Test',
      };

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      });

      await planner.generatePlan('Create a test playlist', []);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5',
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'system' }),
            expect.objectContaining({ role: 'user', content: 'Create a test playlist' }),
          ]),
          response_format: { type: 'json_object' },
        })
      );
    });

    it('should include existing playlists in context', async () => {
      const mockResponse = {
        plan: {
          intent: 'add_tracks',
          steps: [
            { type: 'create_branch', name: 'add-jazz' },
            { type: 'fetch_playlist_tracks', playlistId: 'existing-123' },
            { type: 'commit_changes', message: 'Add tracks' },
          ],
          estimatedChanges: {
            playlistsCreated: 0,
            playlistsModified: 1,
            tracksAdded: 10,
            tracksRemoved: 0,
          },
        },
        confidence: 0.85,
        interpretation: 'Adding jazz tracks to existing playlist',
      };

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }],
      });

      const existingPlaylists = [
        {
          playlistId: 'existing-123',
          name: 'My Jazz Collection',
          folderPath: '/path/to/jazz',
          tracks: [],
          metadata: {
            id: 'existing-123',
            uri: 'spotify:playlist:existing-123',
            name: 'My Jazz Collection',
            description: '',
            isPublic: false,
            collaborative: false,
            snapshotId: 'snap1',
            owner: { id: 'user1', displayName: 'User' },
          },
        },
      ];

      await planner.generatePlan('Add more jazz to my collection', existingPlaylists);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('My Jazz Collection'),
            }),
          ]),
        })
      );
    });

    it('should return fallback plan when LLM fails', async () => {
      mockCreate.mockRejectedValue(new Error('API Error'));

      const result = await planner.generatePlan('Create a playlist', []);

      expect(result.confidence).toBe(0.3);
      expect(result.interpretation).toContain('Fallback');
      expect(result.plan.steps.some((s) => s.type === 'create_playlist')).toBe(true);
    });

    it('should return fallback plan when response is empty', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null } }],
      });

      const result = await planner.generatePlan('Create a playlist', []);

      expect(result.confidence).toBe(0.3);
      expect(result.interpretation).toContain('Fallback');
    });
  });

  describe('extractSearchQueries', () => {
    it('should extract the main prompt', () => {
      const queries = planner.extractSearchQueries('find bossa nova music');
      expect(queries).toContain('find bossa nova music');
    });

    it('should extract quoted strings', () => {
      const queries = planner.extractSearchQueries('find "specific song" in library');
      expect(queries).toContain('specific song');
    });

    it('should deduplicate queries', () => {
      const queries = planner.extractSearchQueries('"test" and "test" again');
      const testCount = queries.filter((q) => q === 'test').length;
      expect(testCount).toBe(1);
    });
  });
});
