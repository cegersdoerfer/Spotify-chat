import { describe, it, expect } from 'vitest';
import { ChatbotPlanner } from '../chatbot/planner.js';

describe('ChatbotPlanner', () => {
  const planner = new ChatbotPlanner();

  describe('analyzeIntent', () => {
    it('should detect create playlist intent', () => {
      const result = planner.analyzeIntent('Create a chill playlist');
      expect(result.intent).toBe('create_playlist');
      expect(result.confidence).toBeGreaterThan(0.7);
    });

    it('should detect genre from prompt', () => {
      const result = planner.analyzeIntent('Make a bossa nova playlist');
      expect(result.entities.genre).toBe('bossa nova');
    });

    it('should detect use of saved tracks', () => {
      const result = planner.analyzeIntent('Create a playlist from my saved songs');
      expect(result.entities.useSavedTracks).toBe('true');
    });

    it('should detect add tracks intent', () => {
      const result = planner.analyzeIntent('Add more jazz tracks to my playlist');
      expect(result.intent).toBe('add_tracks');
    });

    it('should detect remove tracks intent', () => {
      const result = planner.analyzeIntent('Remove all duplicate songs');
      expect(result.intent).toBe('remove_tracks');
    });

    it('should detect target playlist', () => {
      const result = planner.analyzeIntent('Add songs from my favorites playlist');
      expect(result.entities.targetPlaylist).toBeDefined();
    });
  });

  describe('generatePlan', () => {
    it('should generate plan for creating playlist', () => {
      const result = planner.generatePlan('Create a chill playlist', []);

      expect(result.plan.intent).toBe('create_playlist');
      expect(result.plan.steps.length).toBeGreaterThan(0);
      expect(result.plan.steps.some((s) => s.type === 'create_playlist')).toBe(true);
      expect(result.plan.steps.some((s) => s.type === 'create_branch')).toBe(true);
    });

    it('should include saved tracks step when requested', () => {
      const result = planner.generatePlan('Create a playlist from my saved songs', []);

      expect(result.plan.steps.some((s) => s.type === 'fetch_saved_tracks')).toBe(true);
    });

    it('should include search step for genre', () => {
      const result = planner.generatePlan('Make a jazz playlist', []);

      const searchStep = result.plan.steps.find((s) => s.type === 'search_tracks');
      expect(searchStep).toBeDefined();
    });

    it('should include filter step for genre', () => {
      const result = planner.generatePlan('Create a rock playlist', []);

      expect(result.plan.steps.some((s) => s.type === 'filter_tracks')).toBe(true);
    });

    it('should generate interpretation string', () => {
      const result = planner.generatePlan('Create a bossa nova playlist from my saved tracks', []);

      expect(result.interpretation).toContain('Creating');
      expect(result.interpretation).toContain('bossa nova');
    });

    it('should estimate changes', () => {
      const result = planner.generatePlan('Create a new playlist', []);

      expect(result.plan.estimatedChanges.playlistsCreated).toBe(1);
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

    it('should extract genre keywords', () => {
      const queries = planner.extractSearchQueries('get me some jazz tracks');
      expect(queries.some((q) => q.includes('jazz'))).toBe(true);
    });

    it('should deduplicate queries', () => {
      const queries = planner.extractSearchQueries('jazz jazz jazz');
      const jazzCount = queries.filter((q) => q === 'jazz').length;
      expect(jazzCount).toBe(1);
    });
  });
});
