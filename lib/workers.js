/*
*
*  Workers related tasks
*
 */

//  Dependencies
var path = require('path');
var fs = require('fs');
var _data = require('./data');
var https = require('https');
var http = require('http');
var helpers = require('./helpers');
var url = require('url');

// INstantiate the workers object
var workers = {};

// Lookup all checks, get their data, send to a validator
workers.gatherAllChecks = function () {
    // Get all the checks 
    _data.list('checks', function (err, checks) {
        if (!err && checks && checks.length > 0) {
            checks.forEach(function(checks){
                // Read in the check data
                _data.read('checks',checks,function(err,originalCheckData) {
                    if (!err && originalCheckData) {
                        // Pass it to the check validator, and let that function continue or log errors as needed
                        workers.validateCheckData(originalCheckData);
                    } else {
                        console.log('Error reading one of the check\'s data')
                    }
                });
            });
        } else {
            console.log('Error: Could not found any checks to process');
        }
    });
};

// Sanity-check the check-data
workers.validateCheckData = function (originalCheckData) {
    originalCheckData = typeof(originalCheckData) == 'object' && originalCheckData != null ? originalCheckData : {};
    originalCheckData.id = typeof(originalCheckData.id) == 'string' && originalCheckData.id.trim().length == 20 ? originalCheckData.id.trim() : false; 
    originalCheckData.userPhone = typeof(originalCheckData.userPhone) == 'string' && originalCheckData.userPhone.trim().length == 10 ? originalCheckData.userPhone.trim() : false; 
    originalCheckData.protocol = typeof(originalCheckData.protocol) == 'string' && ['http','https'].indexOf(originalCheckData.protocol) > -1 ? originalCheckData.protocol : false; 
    originalCheckData.url = typeof(originalCheckData.url) == 'string' && originalCheckData.url.trim().length > 0 ? originalCheckData.url.trim() : false; 
    originalCheckData.method = typeof(originalCheckData.method) == 'string' && ['post','get','put','delete'].indexOf(originalCheckData.method) > -1 ? originalCheckData.method : false; 
    originalCheckData.successCodes = typeof(originalCheckData.successCodes) == 'object' && originalCheckData.successCodes instanceof Array && originalCheckData.successCodes.length > 0 ? originalCheckData.successCodes : false; 
    originalCheckData.timeoutSeconds = typeof(originalCheckData.timeoutSeconds) == 'number' && originalCheckData.timeoutSeconds % 1 === 0 && originalCheckData.timeoutSeconds >= 1 && originalCheckData.timeoutSeconds <=5 ? originalCheckData.timeoutSeconds : false; 
    // Set the keys that may not be set(if the workers have never seen this check before)
    originalCheckData.state = typeof(originalCheckData.state) == 'string' && ['up','down'].indexOf(originalCheckData.state) > -1 ? originalCheckData.state : 'down'; 
    originalCheckData.lastChecked = typeof(originalCheckData.lastChecked) == 'number' && originalCheckData.lastChecked > 0  ? originalCheckData.lastChecked : false; 
    
    //  If all the checks pass, pass the data along to the next step in the process
    if(originalCheckData.id && 
        originalCheckData.userPhone &&
        originalCheckData.protocol &&
        originalCheckData.url &&
        originalCheckData.method &&
        originalCheckData.successCodes &&
        originalCheckData.timeoutSeconds) {
        workers.performCheck(originalCheckData);
    } else {
        console.log('Error: One of the checks is not properly formated. Skipping it.');
    }
};

// Preform the check, send the originalCheckData and the outcome of the check process, to the next step in the process
workers.performCheck = function (originalCheckData) {
    // Prepare the initial check outcome
    var checkOutcome = {
        'error': false,
        'responseCode': false
    };
    // Mark the outcome has not been set yet
    var outcomeSent = false;

    // Parse the hostname and the path out of the original check data
    var parseUrl = url.parse(originalCheckData.protocol + '://' + originalCheckData.url, true);
    var hostName = parseUrl.hostname
    var path = parseUrl.path; // Using path and not "pathname" because we want the query string

    // Construct the request
    var requestDetails = {
        'protocol': originalCheckData.protocol+':',
        'hostname': hostName,
        'method': originalCheckData.method.toUpperCase(),
        'path': path,
        'timeout': originalCheckData.timeoutSeconds * 1000
    };

    // Instantiate the request object ( using either the http or https module)
    var _moduleToUse = originalCheckData.protocol == 'http' ? http : https;
    var req = _moduleToUse.request(requestDetails, function (res) {
        // Grab the status of the sent request
        var status = res.statusCode;

        // Update the check outcome and pass the data along
        checkOutcome.responseCode = status;
        if (!outcomeSent) {
            workers.procesCheckOutcome(originalCheckData, checkOutcome);
            outcomeSent = true;
        }
    });

    // Bind to the error event so it doesnt get thrown
    req.on('error',function(e) {
        // Update the check outcome and pass the data along
        checkOutcome.error = {
            'error' : true,
            'value' : e
        };
        if (!outcomeSent) {
            workers.procesCheckOutcome(originalCheckData, checkOutcome);
            outcomeSent = true;
        }
    });

    // Bind to the timeout event
    req.on('timeout',function(e) {
        // Update the check outcome and pass the data along
        checkOutcome.error = {
            'error' : true,
            'value' : 'timeout'
        };
        if (!outcomeSent) {
            workers.procesCheckOutcome(originalCheckData, checkOutcome);
            outcomeSent = true;
        }
    });

    // End the request
    req.end();
};
// Timmer to execute the workers-process once per minute
workers.loop = function () {
    setInterval(function() {
        workers.gatherAllChecks();
    },1000 * 60);
};

// Init script
workers.init = function() {
    // Execute all the checks immediatly 
    workers.gatherAllChecks();
    // Call the loop so the checks will execute later on
    workers.loop();
};

// process the check outcome, update the check data as needed, trigger an alert if needed
// Special logic for accomodating a checkthat has never been tested before
workers.procesCheckOutcome = function(originalCheckData, checkOutcome) {
    // Decide if the check is considered up or down
    var state = !checkOutcome.error && checkOutcome.responseCode && originalCheckData.successCodes.indexOf(checkOutcome.responseCode) > -1 ? 'up' : 'down';
    
    // Decide if an alert is warranted
    var alertWarranted = originalCheckData.lastChecked && originalCheckData.state !== state ? true : false;

    // Update the check data
    var newCeckData = originalCheckData;
    newCeckData.state = state;
    newCeckData.lastChecked = Date.now();

    // Save the updates
    _data.update('checks',newCeckData.id,newCeckData, function (err) {
       if (!err) {
        //    Send the new check data to the next phase in the process if needed
        if (alertWarranted) {
            workers.alertToUsersChange(newCeckData);
        }else{
            console.log('Check outcome has not changed, no alert needed');
        }
       } else {
           console.log('Error Trying to save updates to one of the checks');
           
       } 
    });
};

// Alert the users as to change in their check status
workers.alertToUsersChange = function(newCheckData) {
    var msg = 'Alert: Your Check for '+newCheckData.method.toUpperCase()+' '+newCheckData.protocol+'//'+newCheckData.url+' is currcurrently '+newCheckData.state;
    helpers.sendTwilioSms(newCheckData.userPhone,msg,function(err) {
        if (!err) {
            console.log("Success: User was alert to a status change their check, via sms",msg);
        } else {
            console.log('Error: Could not send sms alert to the user who had a stage change in their check');
        }
        
    })
}

// Export the module
module.exports = workers;
