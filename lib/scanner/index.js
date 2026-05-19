const { IGNORED_DIRS, MANIFEST_FILES, MAX_DEPTH, MAX_LANDMINES, SOURCE_EXTENSIONS } = require('./constants');
const { detectExistingProject, detectTechStack } = require('./detect');
const { walkDir, scanProject } = require('./scan');
const { generateMapSkeleton, refreshMap } = require('./map');
const { SEVERITY_MAP, grepLandmines, groupBySeverity, formatLandminesForPlan, formatLandminesForMap } = require('./landmines');
const { analyzeCodePatterns, analyzeDeps, classifyStructureType } = require('./patterns');

module.exports = {
    detectExistingProject,
    detectTechStack,
    walkDir,
    scanProject,
    generateMapSkeleton,
    refreshMap,
    grepLandmines,
    groupBySeverity,
    formatLandminesForPlan,
    formatLandminesForMap,
    analyzeCodePatterns,
    analyzeDeps,
    classifyStructureType,
    SEVERITY_MAP,
    IGNORED_DIRS,
    MANIFEST_FILES,
    MAX_DEPTH,
    MAX_LANDMINES,
    SOURCE_EXTENSIONS,
};
