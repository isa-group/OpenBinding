import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/ui/PageHeader';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import {
  ChangelogPanel, ContributionsPanel, FundingPanel, ResearchPanel, TeamPanel,
} from './AboutPanels';
import { ABOUT_TABS, aboutData, parseAboutTab, type AboutData } from './aboutModel';
import './About.css';

/** Team, research, funding, contribution tracks and changelog: reviewed data in the repository, not served by the API. */
export function About({ data = aboutData }: { data?: AboutData }) {
  const [params, setParams] = useSearchParams();
  const tab = parseAboutTab(params.get('tab'));

  return (
    <div className="about-page">
      <PageHeader
        eyebrow="About"
        title="People, research and changes behind OpenBinding"
        lede="This content is reviewed as data in the repository, not served by the API."
      />
      <TabBar
        prefix="about"
        ariaLabel="About sections"
        value={tab}
        onChange={(id) => setParams({ tab: id })}
        items={ABOUT_TABS}
      />
      <TabPanel prefix="about" active={tab}>
        <div className="about-panel">
          {tab === 'team' && <TeamPanel team={data.team} />}
          {tab === 'research' && <ResearchPanel research={data.research} facts={data.researchFacts} />}
          {tab === 'funding' && <FundingPanel funding={data.funding} related={data.relatedProjects} />}
          {tab === 'contrib' && <ContributionsPanel tracks={data.contributions} />}
          {tab === 'changelog' && <ChangelogPanel changelog={data.changelog} />}
        </div>
      </TabPanel>
    </div>
  );
}
