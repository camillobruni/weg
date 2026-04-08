import L from 'leaflet';
import uPlot from 'uplot';
import FitParser from 'fit-parser';

// Make them available globally if any non-module code still needs them, 
// though we've refactored our internal code to use imports.
window.L = L;
window.uPlot = uPlot;
window.FitParser = FitParser;
