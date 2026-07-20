import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import type { Engine } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { config } from '../../config';
import { useTheme } from '../../contexts/ThemeContext';
import './Home.css';

export function Home() {
  const { theme } = useTheme();
  const [engines, setEngines] = useState<Engine[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadEngines();
  }, []);

  const loadEngines = async () => {
    try {
      const data = await apiClient.getEngines();
      setEngines(data);
    } catch (error) {
      console.error('Failed to load engines:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="home-page">
      {/* Hero Section */}
      <section className="hero-section">
        <div className="container">
          <div className="hero-content">
            <img 
              src={theme === 'dark' ? '/home-logo-dark.jpeg' : '/home-logo-light.png'}
              alt="OpenBinding Logo" 
              className="hero-logo"
            />
            <h1 className="hero-title">
              QoS-Aware Service Composition
              <br />
              <span className="hero-highlight">Made Simple</span>
            </h1>
            <p className="hero-description">
              OpenBinding is a unified gateway for multiple solver engines that enable
              intelligent service composition with Quality of Service guarantees. 
              From constraint satisfaction to heuristic search, choose the right approach 
              for your optimization needs.
            </p>
            <div className="hero-actions">
              <Link to="/playground">
                <Button size="lg">Open Playground</Button>
              </Link>
              <a href={`${config.apiBaseUrl}/docs`} target="_blank" rel="noopener noreferrer">
                <Button variant="secondary" size="lg">View API Docs</Button>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="features-section">
        <div className="container">
          <h2 className="section-title">What You Can Do</h2>
          <div className="features-grid">
            <Card padding="lg">
              <div className="feature-icon">🔍</div>
              <h3 className="feature-title">Analyze Binding Space</h3>
              <p className="feature-description">
                Validate your service composition instances and get detailed reports
                on the binding space, constraints, and potential issues before solving.
              </p>
            </Card>

            <Card padding="lg">
              <div className="feature-icon">⚡</div>
              <h3 className="feature-title">Solve Optimally</h3>
              <p className="feature-description">
                Find optimal service bindings that meet QoS requirements. Support for
                multiple objective types: minimize, maximize, and satisfaction.
              </p>
            </Card>

            <Card padding="lg">
              <div className="feature-icon">🧩</div>
              <h3 className="feature-title">Multiple Engines</h3>
              <p className="feature-description">
                Choose from different solver engines based on your problem characteristics.
                Each engine brings unique strengths to the table.
              </p>
            </Card>

            <Card padding="lg">
              <div className="feature-icon">📊</div>
              <h3 className="feature-title">Rich Diagnostics</h3>
              <p className="feature-description">
                Get comprehensive results including solutions, aggregated QoS metrics,
                provenance information, and detailed error reporting.
              </p>
            </Card>

            <Card padding="lg">
              <div className="feature-icon">🔄</div>
              <h3 className="feature-title">Async Job Processing</h3>
              <p className="feature-description">
                Submit complex problems as background jobs and poll for results.
                Perfect for large-scale composition problems.
              </p>
            </Card>

            <Card padding="lg">
              <div className="feature-icon">🛡️</div>
              <h3 className="feature-title">Multi-Stage Validation</h3>
              <p className="feature-description">
                Four validation stages ensure your instances are correct: schema,
                specialization, semantic, and engine-specific validation.
              </p>
            </Card>

            <Card padding="lg">
              <div className="feature-icon">🌍</div>
              <h3 className="feature-title">Placement-Aware BIM</h3>
              <p className="feature-description">
                Bind FaaS compositions across the Cloud-Edge continuum: resource
                capacities, network latencies, security levels and real on-demand
                pricing budgets — solved as one QoS-aware composition problem.
              </p>
            </Card>

            <Card padding="lg">
              <div className="feature-icon">⏱️</div>
              <h3 className="feature-title">Anytime Solving &amp; Traces</h3>
              <p className="feature-description">
                Shared time budgets across engines, best-so-far convergence traces,
                anytime incumbents from the exact solver, and canonical objective
                values recomputed by a single reference evaluator.
              </p>
            </Card>
          </div>
        </div>
      </section>

      {/* Engines Section */}
      <section className="engines-section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Available Solver Engines</h2>
            <Link to="/engines">
              <Button variant="ghost">Explore All →</Button>
            </Link>
          </div>

          {loading ? (
            <div className="engines-loading">Loading engines...</div>
          ) : engines.length === 0 ? (
            <Card padding="lg">
              <p className="text-center" style={{ color: 'var(--color-text-secondary)' }}>
                No engines available. Make sure the gateway is running.
              </p>
            </Card>
          ) : (
            <div className="engines-grid">
              {engines.map((engine) => (
                <Card key={engine.id} padding="lg" hover>
                  <div className="engine-card-header">
                    <h3 className="engine-card-title">{engine.id}</h3>
                    <Badge variant={engine.active === false ? 'error' : 'accent'}>
                      {engine.active === false ? 'Inactive' : 'Active'}
                    </Badge>
                  </div>
                  <div className="engine-card-capabilities">
                    {engine.capabilities && Object.keys(engine.capabilities).length > 0 ? (
                      <div className="capability-tags">
                        {Object.entries(engine.capabilities).slice(0, 5).map(([key, value]) => (
                          <Badge key={key} variant="default" size="sm">
                            {key}: {Array.isArray(value) ? value.length : typeof value === 'object' && value !== null ? Object.keys(value).length : '✓'}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="text-secondary">Capabilities available via schema</p>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* CTA Section */}
      <section className="cta-section">
        <div className="container">
          <Card padding="lg" className="cta-card">
            <h2 className="cta-title">Ready to Start?</h2>
            <p className="cta-description">
              Try OpenBinding in the playground or dive into the API documentation
              to integrate it into your systems.
            </p>
            <div className="cta-actions">
              <Link to="/playground">
                <Button size="lg">Try Playground</Button>
              </Link>
              <a href={`${config.apiBaseUrl}/docs`} target="_blank" rel="noopener noreferrer">
                <Button variant="secondary" size="lg">Read API Docs</Button>
              </a>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
