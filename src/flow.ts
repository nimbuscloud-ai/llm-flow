import { assign } from 'xstate';
import stateMachine from './state-machine';
import { randomUUID } from 'crypto';

interface Node<Input extends unknown[], Output> {
  type: 'task' | 'workflow';
  id: string;
  execute: (state: any, ...input: Input) => Promise<Output>;
}

const toXState = (workflow: Workflow<any, any>) => {
  const xstateConfig: any = {
    id: 'workflow',
    initial: workflow.nodes[workflow.startNodeId].id,
    states: {},
  };

  const processNode = (
    nodeId: string,
    containingWorkflow: Workflow<any, any>,
    visited: Set<string> = new Set()
  ): void => {
    console.debug('Processing node', {
      nodeId,
      node: containingWorkflow.nodes[nodeId],
      workflow: containingWorkflow,
      visited,
    });
    if (visited.has(nodeId)) {
      console.debug('Already visited node', { nodeId });
      return;
    }

    visited.add(nodeId);

    const node = containingWorkflow.nodes[nodeId] ?? workflow.nodes[nodeId];

    if (node.type === 'workflow' && node instanceof Workflow) {
      processNode(node.startNodeId, node, visited);
      return;
    }

    console.debug('Adding node', { nodeId });
    xstateConfig.states[nodeId] = {};

    xstateConfig.states[nodeId].invoke = {
      src: async context => await node.execute(context, ...context.input),
      onDone: {
        actions: [
          assign({
            result: (_, event) => {
              console.debug('Assigning result', { event });
              return event['data'];
            },
          }),
          assign({
            input: context => {
              console.debug('Assigning input', { context });
              return [context['result']];
            },
          }),
        ],
      },
      onError: {
        action: assign({
          error: (_, event) => {
            return event['data'];
          },
        }),
      },
    };

    if (nodeId === workflow.startNodeId) {
      xstateConfig.states[nodeId].on = {
        INPUT: {
          target: nodeId,
          actions: assign({
            input: (_, event) => {
              return event['data'];
            },
          }),
        },
      };
    }

    const outgoingEdge =
      containingWorkflow.edges[nodeId] ?? workflow.edges[nodeId];

    if (!outgoingEdge) {
      if (nodeId !== workflow.endNodeId) {
        console.warn(`Node ${nodeId} has no outgoing edges and is not the end`);
      }

      xstateConfig.states[nodeId].invoke.onDone.target = '_complete';
      return;
    }

    if (outgoingEdge instanceof ControlFlowEdge) {
      const { __: defaultBranch, ...restBranches } = outgoingEdge.possibilities;
      xstateConfig.states[nodeId].invoke.onDone = [
        ...Object.entries(restBranches).map(([branch, nextNodeId]) => {
          return {
            target: nextNodeId,
            actions: [
              assign({
                result: (_, event) => {
                  return event['data'];
                },
              }),
              assign({
                input: context => {
                  return [context['result']];
                },
              }),
            ],
            cond: (context, event) => {
              console.debug('Checking control flow value', { context, event });
              return `${event.data}` === `${branch}`;
            },
          };
        }),
        ...(defaultBranch
          ? [
              {
                target: defaultBranch,
                actions: [
                  assign({
                    result: (_, event) => {
                      return event['data'];
                    },
                  }),
                  assign({
                    input: context => {
                      return [context['result']];
                    },
                  }),
                ],
                cond: (context, event) => {
                  console.debug('Checking control flow value', {
                    context,
                    event,
                  });
                  return true;
                },
              },
            ]
          : []),
      ];
    } else {
      xstateConfig.states[nodeId].invoke.onDone.target =
        outgoingEdge.possibilities.__;
    }

    console.debug('Next', Object.values(outgoingEdge.possibilities));

    for (const nextNodeId of Object.values(outgoingEdge.possibilities)) {
      console.debug('Processing next node', { nextNodeId });
      processNode(nextNodeId, containingWorkflow, visited);
    }
  };

  processNode(workflow.startNodeId, workflow);

  xstateConfig.states['_complete'] = {
    type: 'final',
  };

  return xstateConfig;
};

interface Edge<I extends string | number | symbol> {
  possibilities: Record<I, string>;
}

const toEdge = (to: string): Edge<any> => {
  return {
    possibilities: { __: to },
  };
};

class ControlFlowEdge<I extends string | number | symbol> implements Edge<I> {
  constructor(readonly possibilities: Record<I, string>) {}
}

export class Workflow<I extends unknown[], O> implements Node<I, O> {
  readonly type: Node<any, any>['type'] = 'workflow';
  readonly id: string;
  readonly startNodeId: string;
  readonly endNodeId: string;
  readonly nodes: Record<string, Node<any, any>> = {};
  readonly edges: Record<string, Edge<any>> = {};

  protected constructor({
    id,
    start,
    end,
    edges,
    nodes,
  }: {
    id: string;
    start: string;
    end: string;
    edges: Record<string, Edge<any>>;
    nodes: Record<string, Node<any, any>>;
  }) {
    this.id = id;
    this.startNodeId = start;
    this.endNodeId = end;
    this.edges = edges;
    this.nodes = nodes;
  }

  then<I2 extends [O], O2>(next: Workflow<I2, O2>): Workflow<I, O2> {
    const edges = {
      ...this.edges,
      ...next.edges,
      [this.endNodeId]: toEdge(next.startNodeId),
    };

    const nodes = {
      ...this.nodes,
      ...next.nodes,
    };

    return new Workflow({
      id: `${this.id} -> ${next.id}`,
      start: this.startNodeId,
      end: next.endNodeId,
      edges,
      nodes,
    });
  }

  when<O2, C extends (string | number) & O>(
    branching: Record<C, Workflow<[O] | [], O2>> &
      Partial<{ __: Workflow<[O] | [], O2> }>
  ): Workflow<I, O2> {
    const mergedNode = Task.from(async (_, result) => {
      return result;
    }, `${this.id}_complete-value`);

    const returnNode = Task.from(async (_, result) => {
      return result;
    }, `${this.id}_return`);

    const nodes = {
      ...this.nodes,
      ...Object.fromEntries(
        Object.values(branching).flatMap((workflow: Workflow<any, any>) => {
          return Object.entries(workflow.nodes);
        })
      ),
      [mergedNode.id]: mergedNode,
      [returnNode.id]: returnNode,
    };

    // to ensure default branch comes last
    const { __: defaultWorkflow, ...restBranches } = branching;

    const edges = {
      ...this.edges,
      ...Object.fromEntries(
        Object.values(branching).flatMap((workflow: Workflow<any, any>) => {
          return Object.entries(workflow.edges);
        })
      ),
      [this.endNodeId]: new ControlFlowEdge(
        Object.fromEntries([
          ...Object.entries(restBranches).map(([branch, workflow]) => {
            return [branch, (workflow as Workflow<any, any>).startNodeId];
          }),
          ...(defaultWorkflow
            ? [['__', defaultWorkflow.id]]
            : [['__', returnNode.id]]),
        ])
      ),
      ...Object.fromEntries([
        ...Object.values(restBranches).map(workflow => {
          return [
            (workflow as Workflow<any, any>).endNodeId,
            toEdge(mergedNode.id),
          ];
        }),
        ...(defaultWorkflow
          ? [[defaultWorkflow.endNodeId, toEdge(mergedNode.id)]]
          : []),
      ]),
    };

    return new Workflow({
      id: this.id,
      start: this.startNodeId,
      end: mergedNode.id,
      edges,
      nodes,
    });
  }

  execute(state: any, ...input: I): Promise<O> {
    return this.run(state, input);
  }

  async run(
    state: any,
    input: I,
    options: {
      timeout: number;
    } = { timeout: 10 * 1000 }
  ): Promise<O> {
    const def = toXState(this);
    const { id, initial, states, context } = def;
    const executor = await stateMachine.synchronize({
      stateRepresentation: {
        id,
        initial,
        states,
        context,
      },
      actions: {},
      savedContext: state,
      savedState: {},
    });
    const result = await executor.execute(input, options);

    return result as O;
  }
}

export class Task<I extends any[], O> extends Workflow<I, O> {
  override type: Node<any, any>['type'] = 'task';

  constructor(
    readonly execute: (state: any, ...input: I) => Promise<O>,
    readonly id: string = randomUUID()
  ) {
    super({
      id,
      start: id,
      end: id,
      edges: {},
      nodes: { [id]: { id, execute, type: 'task' } },
    });
  }

  static from<I2 extends any[], O2>(
    task: Task<I2, O2> | ((state: any, ...input: I2) => Promise<O2>),
    id: string = randomUUID()
  ): Task<I2, O2> {
    if (task instanceof Task) {
      if (task.id === id) {
        return task;
      }

      return new Task(task.execute, id);
    }

    return new Task(task, id);
  }
}