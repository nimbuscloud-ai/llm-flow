import { State, StateMachine, createMachine, interpret } from 'xstate';
import { StateListener } from 'xstate/lib/interpreter';

type ExecutionOptions = {
  timeout?: number;
};

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
      execute: (input, { timeout = 1000 * 10 }: ExecutionOptions) => {
        const service = interpret(stateMachine).start(restoredState);
        const { value, context } = service.initialState;
        console.debug(
          'Initial state',
          JSON.stringify({ value, context }, null, 2)
        );

        return Promise.race([
          new Promise((resolve, reject) => {
            const stateListener: StateListener<any, any, any, any, any> = (
              state,
              event
            ) => {
              console.debug('Entered state:', {
                value: state.value,
                context: state.context,
                history: state.historyValue,
              });
              console.debug('Event:', event);

              if (state.context.error) {
                reject(state.context.error);
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
