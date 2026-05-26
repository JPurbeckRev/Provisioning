/**
 * Cross-Reference Engine
 * Compares Customer Input against Plate OCR and RegDoc OCR.
 * Implements the Strict Match routing logic defined in the PRD.
 */

function validateProvisioningData(customerInput, plateOcr, regDocOcr) {
  let warnings = [];
  let isMatch = true;

  // 1. Check VIN (Must match Customer Input and RegDoc exactly)
  const custVin = (customerInput.VIN || "").trim().toUpperCase();
  const regVin = (regDocOcr.VIN || "").trim().toUpperCase();
  
  if (!custVin || !regVin || custVin !== regVin) {
    isMatch = false;
    warnings.push("VIN_MISMATCH");
  }

  // 2. Check LPN (Must match Customer Input and Plate OCR exactly)
  // We strip spaces for LPN comparison as users often omit them
  const custLpn = (customerInput.LPN || "").replace(/\\s+/g, '').toUpperCase();
  const plateLpn = (plateOcr.plate_string || "").replace(/\\s+/g, '').toUpperCase();
  const regLpn = (regDocOcr["Plate Number"] || "").replace(/\\s+/g, '').toUpperCase();

  if (!custLpn || !plateLpn || custLpn !== plateLpn) {
    isMatch = false;
    warnings.push("LPN_MISMATCH_PLATE");
  }

  // Cross-check LPN against RegDoc if the document provided one
  if (regLpn && custLpn !== regLpn) {
    isMatch = false;
    warnings.push("LPN_MISMATCH_REGDOC");
  }

  // 3. State Match
  const custState = (customerInput.State || "").trim().toUpperCase();
  const regState = (regDocOcr.State || "").trim().toUpperCase();
  if (custState && regState && custState !== regState) {
    warnings.push("STATE_MISMATCH");
  }

  return {
    routingStatus: isMatch ? "AUTO_POPULATE" : "REQUIRES_ATTENTION",
    matchDetails: {
      isVinMatch: custVin === regVin,
      isLpnMatch: custLpn === plateLpn
    },
    warnings: warnings
  };
}

module.exports = { validateProvisioningData };