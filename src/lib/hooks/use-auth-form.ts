import { useMemo, useReducer } from 'react';

export enum AuthMode {
  SignIn = 'sign-in',
  SignUp = 'sign-up',
}

type State = {
  isLoading: boolean;
  mode: AuthMode;
  email: string;
  password: string;
  name: string;
  error: string | null;
};

const ACTION = {
  SET_LOADING: 'SET_LOADING',
  SET_MODE: 'SET_MODE',
  SET_EMAIL: 'SET_EMAIL',
  SET_PASSWORD: 'SET_PASSWORD',
  SET_NAME: 'SET_NAME',
  AUTH_START: 'AUTH_START',
  AUTH_ERROR: 'AUTH_ERROR',
} as const;

type Action =
  | { type: typeof ACTION.SET_LOADING; payload: boolean }
  | { type: typeof ACTION.SET_MODE; payload: AuthMode }
  | { type: typeof ACTION.SET_EMAIL; payload: string }
  | { type: typeof ACTION.SET_PASSWORD; payload: string }
  | { type: typeof ACTION.SET_NAME; payload: string }
  | { type: typeof ACTION.AUTH_START }
  | { type: typeof ACTION.AUTH_ERROR; payload: string };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case ACTION.AUTH_START:
      return { ...state, isLoading: true, error: null };
    case ACTION.AUTH_ERROR:
      return { ...state, isLoading: false, error: action.payload };
    case ACTION.SET_MODE:
      return { ...state, mode: action.payload, error: null };
    case ACTION.SET_EMAIL:
      return { ...state, email: action.payload };
    case ACTION.SET_PASSWORD:
      return { ...state, password: action.payload };
    case ACTION.SET_NAME:
      return { ...state, name: action.payload };
    case ACTION.SET_LOADING:
      return { ...state, isLoading: action.payload };
    default:
      return state;
  }
};

const initialState: State = {
  isLoading: false,
  mode: AuthMode.SignUp,
  email: '',
  password: '',
  name: '',
  error: null,
};

export function useAuthForm() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const actions = useMemo(() => ({
    authStart: () => dispatch({ type: ACTION.AUTH_START }),
    authError: (msg: string) => dispatch({ type: ACTION.AUTH_ERROR, payload: msg }),
    setMode: (mode: AuthMode) => dispatch({ type: ACTION.SET_MODE, payload: mode }),
    setEmail: (v: string) => dispatch({ type: ACTION.SET_EMAIL, payload: v }),
    setPassword: (v: string) => dispatch({ type: ACTION.SET_PASSWORD, payload: v }),
    setName: (v: string) => dispatch({ type: ACTION.SET_NAME, payload: v }),
    setLoading: (v: boolean) => dispatch({ type: ACTION.SET_LOADING, payload: v }),
  }), []);

  return { state, actions };
}
