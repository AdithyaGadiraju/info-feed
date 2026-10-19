import Link from 'next/link';
import { notFound } from 'next/navigation';
import Icon from '@/components/Icon';
import StoryCard from '@/components/StoryCard';
import { getStoryWithItems } from '@/lib/db/queries';

// Digest links land here and must always show the current story, never a snapshot.
export const dynamic = 'force-dynamic';

export default async function StoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Reject anything that is not a plain positive integer before touching the db.
  if (!/^\d+$/.test(id)) notFound();

  const n = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(n) || n <= 0) notFound();

  const story = await getStoryWithItems(n);
  if (!story) notFound();

  return (
    <>
      <div className="mb-5">
        <Link href="/" className="back-link">
          <Icon name="back" />
          All stories
        </Link>
      </div>
      {/* Pre-expanded with the detail already in hand, so the page is complete
          HTML with JavaScript disabled. The story title is this page's h1. */}
      <StoryCard
        story={{ ...story, itemCount: story.items.length }}
        initialDetail={story}
        defaultExpanded
        headingLevel={1}
      />
    </>
  );
}
