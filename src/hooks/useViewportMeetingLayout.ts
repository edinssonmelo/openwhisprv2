import { useEffect, useState } from 'react';

export type MeetingDetailLayout = 'sm' | 'md' | 'lg';

function computeLayout(width: number): MeetingDetailLayout {
  if (width < 760) return 'sm';
  if (width < 1080) return 'md';
  return 'lg';
}

export function useViewportMeetingLayout(): MeetingDetailLayout {
  const [layout, setLayout] = useState<MeetingDetailLayout>(() =>
    typeof window !== 'undefined' ? computeLayout(window.innerWidth) : 'lg',
  );

  useEffect(() => {
    const onResize = () => setLayout(computeLayout(window.innerWidth));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return layout;
}
