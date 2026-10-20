import { redirect } from 'next/navigation';

// The organisation moved onto the users page. This only keeps old bookmarks working;
// /admin/brugere gates itself, so nothing is revealed here.
export default function OrganisationRedirectPage() {
  redirect('/admin/brugere');
}
