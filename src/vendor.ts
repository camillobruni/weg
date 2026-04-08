import L from 'leaflet';
import uPlot from 'uplot';
import FitParser from 'fit-file-parser';

// Make them available globally if any non-module code still needs them,
// though we've refactored our internal code to use imports.
(window as any).L = L;
(window as any).uPlot = uPlot;
(window as any).FitParser = FitParser;
