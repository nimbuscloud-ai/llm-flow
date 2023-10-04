import { Task } from '../src/flow';

describe('flow service', () => {
  test('should execute a flow', async () => {
    const toQueryTask = Task.from(async ({ invocationArgs: [query] }) => {
      return `{"query": "a&b:${query}"}`;
    }, 'to-query');

    const verifyQueryTask = Task.from(async (_, query) => query.endsWith('?') ? 'yes' : 'You need to end your question with a ?', 'verify-query');

    const refineQueryTask = Task.from(
      async ({ history, invocationArgs: [query] }) => {
        return `{"query": "a&b:${history[history.length - 1]?.content ?? 'None'}&c:${query}"}`;
      },
      'refine-query'
    );

    const branches = {
      0: 'NEW_QUERY',
      1: 'REFINE_QUERY',
      2: 'NEW_QUERY',
    } as const;

    const controlFlowTask = Task.from(
      async ({ invocationArgs: [query] }): Promise<(typeof branches)[keyof typeof branches]> => {
        const branch = branches[query.length % 3];
        console.log(`Control flow result: ${branch}`);
        return branch;
      },
      'control-flow'
    );

    const queryConstruction = controlFlowTask.when({
      NEW_QUERY: toQueryTask,
      REFINE_QUERY: refineQueryTask,
    });

    const searchFlow = verifyQueryTask.when({
      yes: queryConstruction,
    });

    const messages = [
      {
        content: 'hello',
        role: 'user',
      } as const,
    ];

    const getState = (messageList: { content: string; role: string }[]) => ({
      history: messageList.slice(0, -1),
      invocationArgs: [messageList[messageList.length - 1].content],
    });

    const result = await searchFlow.run(getState(messages), [messages[messages.length - 1].content]);

    expect(result).toEqual('You need to end your question with a ?');

    const messages2 = [
      {
        content: 'hello?',
        role: 'user',
      } as const,
    ];

    const result2 = await searchFlow.run(getState(messages2), [messages2[messages2.length - 1].content]);

    expect(result2).toEqual('{"query": "a&b:hello?"}');
    
    const messages3 = [
      {
        content: 'hmmm',
        role: 'user',
      } as const,
      {
        content: 'hey?',
        role: 'user',
      } as const,
    ];

    const result3 = await searchFlow.run(getState(messages3), [messages3[messages3.length - 1].content]);

    expect(result3).toEqual('{"query": "a&b:hmmm&c:hey?"}');
  });
});
