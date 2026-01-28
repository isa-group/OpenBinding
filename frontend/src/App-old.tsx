import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { Navigation } from './components/Navigation/Navigation';
import { Home } from './pages/Home/Home';
import { Playground } from './pages/Playground/Playground';
import { Engines } from './pages/Engines/Engines';
import { Schemas } from './pages/Schemas/Schemas';
import './styles/globals.css';

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <div className="app-container">
          <Navigation />
          <main className="main-content">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/playground" element={<Playground />} />
              <Route path="/engines" element={<Engines />} />
              <Route path="/schemas" element={<Schemas />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
