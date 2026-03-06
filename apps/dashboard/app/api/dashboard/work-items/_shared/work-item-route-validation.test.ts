import { describe, expect, it } from 'vitest';
import { DashboardIntegrationError } from '@dashboard/server/dashboard-errors';
import {
  parseApproveStoryBreakdownRequest,
  parseCreateWorkItemRequest,
  parseJsonObjectBody,
  parseLaunchStoryBreakdownRunRequest,
  parseMoveWorkItemStatusRequest,
  parseProposeStoryBreakdownRequest,
  parseRequestWorkItemReplanRequest,
  parseRepositoryIdFromPathSegment,
  parseRepositoryIdFromQuery,
  parseRunIdFromPathSegment,
  parseRunStoryWorkflowRequest,
  parseUpdateWorkItemFieldsRequest,
  parseWorkItemIdFromPathSegment,
} from './work-item-route-validation';

function expectInvalidRequest(error: unknown, message: string): void {
  expect(error).toBeInstanceOf(DashboardIntegrationError);
  expect(error).toMatchObject({
    code: 'invalid_request',
    status: 400,
    message,
  });
}

function baseCreatePayload(): Record<string, unknown> {
  return {
    type: 'story',
    title: 'Ship parser coverage',
    actorType: 'human',
    actorLabel: 'alice',
  };
}

function baseUpdatePayload(): Record<string, unknown> {
  return {
    repositoryId: 7,
    expectedRevision: 3,
    actorType: 'agent',
    actorLabel: 'builder',
  };
}

describe('work item route validation', () => {
  describe('parseJsonObjectBody', () => {
    const options = {
      invalidJsonMessage: 'payload must be valid JSON',
      objectMessage: 'payload must be an object',
    };

    it('parses JSON object payloads', async () => {
      const parsed = await parseJsonObjectBody(
        new Request('http://localhost/api/dashboard/work-items', {
          method: 'POST',
          body: JSON.stringify({ ok: true }),
        }),
        options,
      );

      expect(parsed).toEqual({ ok: true });
    });

    it('rejects empty request bodies', async () => {
      await expect(
        parseJsonObjectBody(
          new Request('http://localhost/api/dashboard/work-items', {
            method: 'POST',
            body: '   ',
          }),
          options,
        ),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        status: 400,
        message: options.objectMessage,
      });
    });

    it('rejects malformed JSON payloads', async () => {
      await expect(
        parseJsonObjectBody(
          new Request('http://localhost/api/dashboard/work-items', {
            method: 'POST',
            body: '{"broken"',
          }),
          options,
        ),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        status: 400,
        message: options.invalidJsonMessage,
      });
    });

    it('rejects non-object JSON payloads', async () => {
      await expect(
        parseJsonObjectBody(
          new Request('http://localhost/api/dashboard/work-items', {
            method: 'POST',
            body: '[]',
          }),
          options,
        ),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        status: 400,
        message: options.objectMessage,
      });
    });
  });

  describe('route id parsing', () => {
    it('parses repository and work item path segments', () => {
      expect(parseRepositoryIdFromPathSegment('15')).toBe(15);
      expect(parseRunIdFromPathSegment('23')).toBe(23);
      expect(parseWorkItemIdFromPathSegment('41')).toBe(41);
    });

    it('rejects invalid path segments', () => {
      expect(() => parseRepositoryIdFromPathSegment('0')).toThrowError(DashboardIntegrationError);
      expect(() => parseRunIdFromPathSegment('0')).toThrowError(DashboardIntegrationError);
      expect(() => parseWorkItemIdFromPathSegment('abc')).toThrowError(DashboardIntegrationError);
    });

    it('parses repositoryId from query params', () => {
      expect(parseRepositoryIdFromQuery(new Request('http://localhost/?repositoryId=11'))).toBe(11);
    });

    it('rejects missing and invalid repositoryId query params', () => {
      expect(() => parseRepositoryIdFromQuery(new Request('http://localhost/'))).toThrowError(DashboardIntegrationError);
      expect(() => parseRepositoryIdFromQuery(new Request('http://localhost/?repositoryId=1.2'))).toThrowError(
        DashboardIntegrationError,
      );
    });
  });

  describe('parseCreateWorkItemRequest', () => {
    it('parses required and optional fields', () => {
      const request = parseCreateWorkItemRequest(
        {
          ...baseCreatePayload(),
          status: 'Draft',
          description: 'Initial draft',
          parentId: 9,
          tags: ['backend'],
          plannedFiles: ['src/parser.ts'],
          assignees: ['alice'],
          priority: 0.7,
          estimate: 3,
        },
        5,
      );

      expect(request).toEqual({
        repositoryId: 5,
        type: 'story',
        title: 'Ship parser coverage',
        actorType: 'human',
        actorLabel: 'alice',
        status: 'Draft',
        description: 'Initial draft',
        parentId: 9,
        tags: ['backend'],
        plannedFiles: ['src/parser.ts'],
        assignees: ['alice'],
        priority: 0.7,
        estimate: 3,
      });
    });

    it('accepts null optional fields', () => {
      const request = parseCreateWorkItemRequest(
        {
          ...baseCreatePayload(),
          description: null,
          parentId: null,
          tags: null,
          plannedFiles: null,
          assignees: null,
          priority: null,
          estimate: null,
        },
        6,
      );

      expect(request).toEqual({
        repositoryId: 6,
        type: 'story',
        title: 'Ship parser coverage',
        actorType: 'human',
        actorLabel: 'alice',
        description: null,
        parentId: null,
        tags: null,
        plannedFiles: null,
        assignees: null,
        priority: null,
        estimate: null,
      });
    });

    it('rejects invalid required fields', () => {
      expect(() => parseCreateWorkItemRequest({ ...baseCreatePayload(), type: 'defect' }, 2)).toThrowError(
        DashboardIntegrationError,
      );
      expect(() => parseCreateWorkItemRequest({ ...baseCreatePayload(), actorType: 'bot' }, 2)).toThrowError(
        DashboardIntegrationError,
      );
      expect(() => parseCreateWorkItemRequest({ ...baseCreatePayload(), actorLabel: 5 }, 2)).toThrowError(
        DashboardIntegrationError,
      );
    });

    it('rejects invalid optional fields', () => {
      expect(() => parseCreateWorkItemRequest({ ...baseCreatePayload(), status: 'Queued' }, 2)).toThrowError(
        DashboardIntegrationError,
      );
      expect(() => parseCreateWorkItemRequest({ ...baseCreatePayload(), parentId: 0 }, 2)).toThrowError(
        DashboardIntegrationError,
      );
      expect(() => parseCreateWorkItemRequest({ ...baseCreatePayload(), tags: ['ok', 7] }, 2)).toThrowError(
        DashboardIntegrationError,
      );
      expect(() =>
        parseCreateWorkItemRequest({ ...baseCreatePayload(), plannedFiles: 'src/parser.ts' }, 2),
      ).toThrowError(DashboardIntegrationError);
      expect(() => parseCreateWorkItemRequest({ ...baseCreatePayload(), priority: Number.POSITIVE_INFINITY }, 2)).toThrowError(
        DashboardIntegrationError,
      );
      expect(() => parseCreateWorkItemRequest({ ...baseCreatePayload(), estimate: '3' }, 2)).toThrowError(
        DashboardIntegrationError,
      );
    });
  });

  describe('parseUpdateWorkItemFieldsRequest', () => {
    it('parses updates with all optional fields', () => {
      const request = parseUpdateWorkItemFieldsRequest(
        {
          ...baseUpdatePayload(),
          title: 'Updated title',
          description: 'Updated description',
          tags: ['frontend'],
          plannedFiles: ['app/page.tsx'],
          assignees: ['bob'],
          priority: 2,
          estimate: 8,
        },
        99,
      );

      expect(request).toEqual({
        repositoryId: 7,
        workItemId: 99,
        expectedRevision: 3,
        actorType: 'agent',
        actorLabel: 'builder',
        title: 'Updated title',
        description: 'Updated description',
        tags: ['frontend'],
        plannedFiles: ['app/page.tsx'],
        assignees: ['bob'],
        priority: 2,
        estimate: 8,
      });
    });

    it('accepts null optional update values', () => {
      const request = parseUpdateWorkItemFieldsRequest(
        {
          ...baseUpdatePayload(),
          description: null,
          tags: null,
          plannedFiles: null,
          assignees: null,
          priority: null,
          estimate: null,
        },
        100,
      );

      expect(request).toEqual({
        repositoryId: 7,
        workItemId: 100,
        expectedRevision: 3,
        actorType: 'agent',
        actorLabel: 'builder',
        description: null,
        tags: null,
        plannedFiles: null,
        assignees: null,
        priority: null,
        estimate: null,
      });
    });

    it('rejects payloads with no updatable fields', () => {
      try {
        parseUpdateWorkItemFieldsRequest(baseUpdatePayload(), 9);
        throw new Error('Expected update parser to throw');
      } catch (error) {
        expectInvalidRequest(error, 'Work item update requires at least one updatable field.');
      }
    });

    it('rejects invalid required and optional update fields', () => {
      expect(() => parseUpdateWorkItemFieldsRequest({ ...baseUpdatePayload(), repositoryId: 0, title: 'ok' }, 1)).toThrowError(
        DashboardIntegrationError,
      );
      expect(() =>
        parseUpdateWorkItemFieldsRequest({ ...baseUpdatePayload(), expectedRevision: -1, title: 'ok' }, 1),
      ).toThrowError(DashboardIntegrationError);
      expect(() =>
        parseUpdateWorkItemFieldsRequest({ ...baseUpdatePayload(), expectedRevision: 1.1, title: 'ok' }, 1),
      ).toThrowError(DashboardIntegrationError);
      expect(() => parseUpdateWorkItemFieldsRequest({ ...baseUpdatePayload(), title: 42 }, 1)).toThrowError(
        DashboardIntegrationError,
      );
      expect(() => parseUpdateWorkItemFieldsRequest({ ...baseUpdatePayload(), tags: [true], title: 'ok' }, 1)).toThrowError(
        DashboardIntegrationError,
      );
    });
  });

  describe('parseMoveWorkItemStatusRequest', () => {
    it('parses valid status moves', () => {
      expect(
        parseMoveWorkItemStatusRequest(
          {
            repositoryId: 9,
            expectedRevision: 0,
            toStatus: 'InReview',
            actorType: 'system',
            actorLabel: 'autobot',
          },
          81,
        ),
      ).toEqual({
        repositoryId: 9,
        workItemId: 81,
        expectedRevision: 0,
        toStatus: 'InReview',
        actorType: 'system',
        actorLabel: 'autobot',
      });
    });

    it('rejects invalid toStatus values', () => {
      try {
        parseMoveWorkItemStatusRequest(
          {
            repositoryId: 9,
            expectedRevision: 0,
            toStatus: 'Queued',
            actorType: 'system',
            actorLabel: 'autobot',
          },
          81,
        );
        throw new Error('Expected move parser to throw');
      } catch (error) {
        expectInvalidRequest(error, 'Field "toStatus" must be a valid work-item status string.');
      }
    });
  });

  describe('parseRequestWorkItemReplanRequest', () => {
    it('parses valid replan action payloads', () => {
      expect(
        parseRequestWorkItemReplanRequest(
          {
            actorType: 'human',
            actorLabel: 'alice',
          },
          4,
          81,
        ),
      ).toEqual({
        repositoryId: 4,
        workItemId: 81,
        actorType: 'human',
        actorLabel: 'alice',
      });
    });

    it('rejects invalid replan action payloads', () => {
      expect(() =>
        parseRequestWorkItemReplanRequest(
          {
            actorType: 'bot',
            actorLabel: 'alice',
          },
          4,
          81,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseRequestWorkItemReplanRequest(
          {
            actorType: 'human',
            actorLabel: 123,
          },
          4,
          81,
        ),
      ).toThrowError(DashboardIntegrationError);
    });
  });

  describe('parseProposeStoryBreakdownRequest', () => {
    it('parses full proposed breakdown payloads', () => {
      const request = parseProposeStoryBreakdownRequest(
        {
          repositoryId: 4,
          expectedRevision: 2,
          actorType: 'human',
          actorLabel: 'alice',
          proposed: {
            tasks: [
              {
                title: 'Implement endpoint',
                description: 'Create API route',
                tags: ['api'],
                plannedFiles: ['app/api/route.ts'],
                assignees: ['alice'],
                priority: 1,
                estimate: 5,
                links: ['https://example.com/spec'],
              },
            ],
            tags: ['story'],
            plannedFiles: ['README.md'],
            links: ['https://example.com/story'],
          },
        },
        101,
      );

      expect(request).toEqual({
        repositoryId: 4,
        storyId: 101,
        expectedRevision: 2,
        actorType: 'human',
        actorLabel: 'alice',
        proposed: {
          tasks: [
            {
              title: 'Implement endpoint',
              description: 'Create API route',
              tags: ['api'],
              plannedFiles: ['app/api/route.ts'],
              assignees: ['alice'],
              priority: 1,
              estimate: 5,
              links: ['https://example.com/spec'],
            },
          ],
          tags: ['story'],
          plannedFiles: ['README.md'],
          links: ['https://example.com/story'],
        },
      });
    });

    it('accepts null optional fields in proposed payloads', () => {
      const request = parseProposeStoryBreakdownRequest(
        {
          repositoryId: 4,
          expectedRevision: 2,
          actorType: 'human',
          actorLabel: 'alice',
          proposed: {
            tasks: [
              {
                title: 'Implement endpoint',
                description: null,
                tags: null,
                plannedFiles: null,
                assignees: null,
                priority: null,
                estimate: null,
                links: null,
              },
            ],
            tags: null,
            plannedFiles: null,
            links: null,
          },
        },
        102,
      );

      expect(request).toEqual({
        repositoryId: 4,
        storyId: 102,
        expectedRevision: 2,
        actorType: 'human',
        actorLabel: 'alice',
        proposed: {
          tasks: [
            {
              title: 'Implement endpoint',
              description: null,
              tags: null,
              plannedFiles: null,
              assignees: null,
              priority: null,
              estimate: null,
              links: null,
            },
          ],
          tags: null,
          plannedFiles: null,
          links: null,
        },
      });
    });

    it('rejects malformed proposed breakdown payloads', () => {
      expect(() =>
        parseProposeStoryBreakdownRequest(
          {
            repositoryId: 4,
            expectedRevision: 2,
            actorType: 'human',
            actorLabel: 'alice',
            proposed: [],
          },
          1,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseProposeStoryBreakdownRequest(
          {
            repositoryId: 4,
            expectedRevision: 2,
            actorType: 'human',
            actorLabel: 'alice',
            proposed: { tasks: 'not-an-array' },
          },
          1,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseProposeStoryBreakdownRequest(
          {
            repositoryId: 4,
            expectedRevision: 2,
            actorType: 'human',
            actorLabel: 'alice',
            proposed: { tasks: [] },
          },
          1,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseProposeStoryBreakdownRequest(
          {
            repositoryId: 4,
            expectedRevision: 2,
            actorType: 'human',
            actorLabel: 'alice',
            proposed: { tasks: [null] },
          },
          1,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseProposeStoryBreakdownRequest(
          {
            repositoryId: 4,
            expectedRevision: 2,
            actorType: 'human',
            actorLabel: 'alice',
            proposed: { tasks: [{ title: 99 }] },
          },
          1,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseProposeStoryBreakdownRequest(
          {
            repositoryId: 4,
            expectedRevision: 2,
            actorType: 'human',
            actorLabel: 'alice',
            proposed: { tasks: [{ title: 'ok', links: [1] }] },
          },
          1,
        ),
      ).toThrowError(DashboardIntegrationError);
    });
  });

  describe('parseApproveStoryBreakdownRequest', () => {
    it('parses approve breakdown payloads', () => {
      expect(
        parseApproveStoryBreakdownRequest(
          {
            repositoryId: 3,
            expectedRevision: 1,
            actorType: 'human',
            actorLabel: 'alice',
          },
          20,
        ),
      ).toEqual({
        repositoryId: 3,
        storyId: 20,
        expectedRevision: 1,
        actorType: 'human',
        actorLabel: 'alice',
      });
    });

    it('rejects invalid approve breakdown payloads', () => {
      expect(() =>
        parseApproveStoryBreakdownRequest(
          {
            repositoryId: '3',
            expectedRevision: 1,
            actorType: 'human',
            actorLabel: 'alice',
          },
          20,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseApproveStoryBreakdownRequest(
          {
            repositoryId: 3,
            expectedRevision: '1',
            actorType: 'human',
            actorLabel: 'alice',
          },
          20,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseApproveStoryBreakdownRequest(
          {
            repositoryId: 3,
            expectedRevision: 1,
            actorType: 'human',
            actorLabel: null,
          },
          20,
        ),
      ).toThrowError(DashboardIntegrationError);
    });
  });

  describe('parseLaunchStoryBreakdownRunRequest', () => {
    it('parses launch payloads', () => {
      expect(
        parseLaunchStoryBreakdownRunRequest(
          {
            repositoryId: 5,
            expectedRevision: 3,
          },
          20,
        ),
      ).toEqual({
        repositoryId: 5,
        storyId: 20,
        expectedRevision: 3,
      });
    });

    it('rejects invalid launch payloads', () => {
      expect(() =>
        parseLaunchStoryBreakdownRunRequest(
          {
            repositoryId: '5',
            expectedRevision: 3,
          },
          20,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseLaunchStoryBreakdownRunRequest(
          {
            repositoryId: 5,
            expectedRevision: -1,
          },
          20,
        ),
      ).toThrowError(DashboardIntegrationError);
    });
  });

  describe('parseRunStoryWorkflowRequest', () => {
    it('parses orchestration payloads with mode flags', () => {
      expect(
        parseRunStoryWorkflowRequest(
          {
            repositoryId: 9,
            expectedRevision: 4,
            actorType: 'human',
            actorLabel: 'alice',
            approveAndStart: true,
          },
          22,
        ),
      ).toEqual({
        repositoryId: 9,
        storyId: 22,
        expectedRevision: 4,
        actorType: 'human',
        actorLabel: 'alice',
        approveAndStart: true,
      });
    });

    it('rejects invalid orchestration payloads', () => {
      expect(() =>
        parseRunStoryWorkflowRequest(
          {
            repositoryId: '9',
            expectedRevision: 4,
            actorType: 'human',
            actorLabel: 'alice',
          },
          22,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseRunStoryWorkflowRequest(
          {
            repositoryId: 9,
            expectedRevision: 4,
            actorType: 'human',
            actorLabel: 'alice',
            generateOnly: 'true',
          },
          22,
        ),
      ).toThrowError(DashboardIntegrationError);

      expect(() =>
        parseRunStoryWorkflowRequest(
          {
            repositoryId: 9,
            expectedRevision: 4,
            actorType: 'human',
            actorLabel: 'alice',
            generateOnly: true,
            approveOnly: true,
          },
          22,
        ),
      ).toThrowError(DashboardIntegrationError);
    });
  });
});
