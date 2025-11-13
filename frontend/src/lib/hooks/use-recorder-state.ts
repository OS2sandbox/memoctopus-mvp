import { RECORDER_STATUS } from "@/lib/constants";

import { useReducer } from "react";

type State = {
  status: RECORDER_STATUS;
  error: string | null;
  url: string | null;
  file: File | null;
  blob: Blob | null;
  time: number;
};

const ACTION = {
  START_RECORDING: "START_RECORDING",
  STOP_RECORDING: "STOP_RECORDING",
  PAUSE_RECORDING: "PAUSE_RECORDING",
  RESUME_RECORDING: "RESUME_RECORDING",
  SET_TIME: "SET_TIME",
  SET_ERROR: "SET_ERROR",
  RESET_RECORDER: "RESET_RECORDER",
} as const;

type Action =
  | { type: typeof ACTION.START_RECORDING }
  | {
      type: typeof ACTION.STOP_RECORDING;
      payload: { blob: Blob; file: File; url: string };
    }
  | { type: typeof ACTION.PAUSE_RECORDING }
  | { type: typeof ACTION.RESUME_RECORDING }
  | { type: typeof ACTION.SET_TIME; payload: number }
  | { type: typeof ACTION.SET_ERROR; payload: string }
  | { type: typeof ACTION.RESET_RECORDER };

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case ACTION.START_RECORDING:
      return {
        ...state,
        status: RECORDER_STATUS.Recording,
        error: null,
        time: 0,
      };
    case ACTION.STOP_RECORDING:
      return {
        ...state,
        status: RECORDER_STATUS.Stopped,
        blob: action.payload.blob,
        file: action.payload.file,
        url: action.payload.url,
      };
    case ACTION.PAUSE_RECORDING:
      return { ...state, status: RECORDER_STATUS.Paused };
    case ACTION.RESUME_RECORDING:
      return { ...state, status: RECORDER_STATUS.Recording };
    case ACTION.SET_TIME:
      return {
        ...state,
        time: action.payload,
      };
    case ACTION.SET_ERROR:
      return { ...state, status: RECORDER_STATUS.Error, error: action.payload };
    case ACTION.RESET_RECORDER:
      return {
        status: RECORDER_STATUS.Idle,
        error: null,
        url: null,
        file: null,
        blob: null,
        time: 0,
      };
    default: {
      throw Error("Unknown action type");
    }
  }
};

const initialState: State = {
  status: RECORDER_STATUS.Idle,
  error: null,
  url: null,
  file: null,
  blob: null,
  time: 0,
};

export const useRecorderState = () => {
  const [state, dispatch] = useReducer(reducer, initialState);

  const {
    START_RECORDING,
    STOP_RECORDING,
    PAUSE_RECORDING,
    RESUME_RECORDING,
    SET_TIME,
    SET_ERROR,
    RESET_RECORDER,
  } = ACTION;

  const actions = {
    startRecording: () => dispatch({ type: START_RECORDING }),
    stopRecording: (payload: { blob: Blob; file: File; url: string }) =>
      dispatch({ type: STOP_RECORDING, payload }),
    pauseRecording: () => dispatch({ type: PAUSE_RECORDING }),
    resumeRecording: () => dispatch({ type: RESUME_RECORDING }),
    setTime: (time: number) => dispatch({ type: SET_TIME, payload: time }),
    setError: (msg: string) => dispatch({ type: SET_ERROR, payload: msg }),
    resetRecorder: () => dispatch({ type: RESET_RECORDER }),
  };

  return { state, actions };
};
