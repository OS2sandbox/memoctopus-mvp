import { AUTH_MODE } from "@/lib/constants";

import { useReducer } from "react";

type State = {
  isLoading: boolean;
  mode: AUTH_MODE;
  email: string;
  password: string;
  name: string;
  error: string | null;
};

const ACTION = {
  SET_LOADING: "SET_LOADING",
  SET_MODE: "SET_MODE",
  SET_EMAIL: "SET_EMAIL",
  SET_PASSWORD: "SET_PASSWORD",
  SET_NAME: "SET_NAME",
  SET_ERROR: "SET_ERROR",
  AUTH_START: "AUTH_START",
  AUTH_ERROR: "AUTH_ERROR",
  RESET_FORM: "RESET_FORM",
} as const;

type Action =
  | { type: typeof ACTION.SET_LOADING; payload: boolean }
  | { type: typeof ACTION.SET_MODE; payload: AUTH_MODE }
  | { type: typeof ACTION.SET_EMAIL; payload: string }
  | { type: typeof ACTION.SET_PASSWORD; payload: string }
  | { type: typeof ACTION.SET_NAME; payload: string }
  | { type: typeof ACTION.SET_ERROR; payload: string | null }
  | { type: typeof ACTION.AUTH_START }
  | { type: typeof ACTION.AUTH_ERROR; payload: string }
  | { type: typeof ACTION.RESET_FORM };

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
    case ACTION.SET_ERROR:
      return { ...state, error: action.payload };
    case ACTION.SET_LOADING:
      return { ...state, isLoading: action.payload };
    case ACTION.RESET_FORM:
      return {
        isLoading: false,
        mode: AUTH_MODE.SignIn,
        email: "",
        password: "",
        name: "",
        error: null,
      };

    default: {
      throw Error("Unknown action type");
    }
  }
};

const initialState = {
  isLoading: false,
  mode: AUTH_MODE.SignIn,
  email: "",
  password: "",
  name: "",
  error: null,
};

export const useAuthForm = () => {
  const [state, dispatch] = useReducer(reducer, initialState);

  const {
    AUTH_START,
    AUTH_ERROR,
    SET_MODE,
    SET_EMAIL,
    SET_PASSWORD,
    SET_NAME,
    SET_LOADING,
    RESET_FORM,
  } = ACTION;

  const actions = {
    authStart: () => dispatch({ type: AUTH_START }),
    authError: (msg: string) => dispatch({ type: AUTH_ERROR, payload: msg }),
    setMode: (mode: AUTH_MODE) => dispatch({ type: SET_MODE, payload: mode }),
    setEmail: (v: string) => dispatch({ type: SET_EMAIL, payload: v }),
    setPassword: (v: string) => dispatch({ type: SET_PASSWORD, payload: v }),
    setName: (v: string) => dispatch({ type: SET_NAME, payload: v }),
    setLoading: (v: boolean) => dispatch({ type: SET_LOADING, payload: v }),
    resetForm: () => dispatch({ type: RESET_FORM }),
  };

  return { state, actions };
};
