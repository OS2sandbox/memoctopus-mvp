'use client';

import { createContext, useContext, useState } from 'react';

type ReviewAudioCtx = { hasAudio: boolean; setHasAudio: (v: boolean) => void };

const ReviewAudioContext = createContext<ReviewAudioCtx>({
  hasAudio: false,
  setHasAudio: () => {},
});

export function ReviewAudioProvider({ children }: { children: React.ReactNode }) {
  const [hasAudio, setHasAudio] = useState(false);
  return (
    <ReviewAudioContext.Provider value={{ hasAudio, setHasAudio }}>
      {children}
    </ReviewAudioContext.Provider>
  );
}

export function useReviewAudio() {
  return useContext(ReviewAudioContext);
}
