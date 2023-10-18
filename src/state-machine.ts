import { State, StateMachine, createMachine, interpret } from 'xstate';
import { StateListener } from 'xstate/lib/interpreter';

type LogMethod = (...args: any[]) => void;
export interface Logger { 
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  debug: LogMethod;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = typeof LOG_LEVELS[number];

const noOp = () => {};

export const DEFAULT_LOGGER = (logLevel: LogLevel) => {
  const logAtLevel = (methodLevel: LogLevel, logMethod: LogMethod) => LOG_LEVELS.indexOf(logLevel) <= LOG_LEVELS.indexOf(methodLevel) ? (...args) => logMethod(`[${methodLevel.toUpperCase()}]`, ...args): noOp;

  return {
    debug: logAtLevel('debug', console.debug),
    info: logAtLevel('info', console.log),
    warn: logAtLevel('warn', console.warn),
    error: logAtLevel('error', console.error),
  }
};

export type ExecutionOptions = {
  timeout?: number;
  logger?: Logger;
};

export class FlowError extends Error {
  constructor(message: string, public stack: string, public task: string) {
    super(message);
  }
}

export const isFlowError = (error: any): error is FlowError => error instanceof FlowError;

class Executor {
  stateMachine: StateMachine<any, any, any>;

  static async synchronize({
    stateRepresentation,
    actions,
    savedContext,
    savedState,
  }) {
    const stateMachine = createMachine(
      {
        predictableActionArguments: true,
        ...stateRepresentation,
      },
      actions
    );
    const currentState = State.from(savedState, savedContext);
    const restoredState = stateMachine.resolveState(currentState);

    return {
      execute: (input, { timeout = 1000 * 10, logger = DEFAULT_LOGGER((process.env.LOG_LEVEL ?? 'debug') as LogLevel) }: ExecutionOptions) => {
        const service = interpret(stateMachine).start(restoredState);
        const { value, context } = service.initialState;
        logger.debug(
          'Initial state',
          JSON.stringify({ value, context }, null, 2)
        );

        return Promise.race([
          new Promise((resolve, reject) => {
            const stateListener: StateListener<any, any, any, any, any> = (
              state,
              event
            ) => {
              logger.debug('Entered state:', {
                value: state.value,
                context: state.context,
                history: state.historyValue,
              });
              logger.debug('Event:', event);

              if (state.context.error) {
                reject(new FlowError(
                  state.context.error.message,
                  state.context.error.stack,
                  state.value as string,
                ));
                return;
              }

              if (state.value === '_complete') {
                service.off(stateListener);

                resolve(state.context.result);
                return;
              }
            };
            service.onTransition(stateListener);
            // Start the service and send the input event
            service.start().send('INPUT', { data: input });
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), timeout)
          ),
        ]);
      },
    };
  }
}

export default Executor;
