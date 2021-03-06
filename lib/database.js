var mongoose = require('mongoose')
  , Stats = require('../models/stats')
  , Markets = require('../models/markets')
  , Masternode = require('../models/masternode')
  , Address = require('../models/address')
  , AddressTx = require('../models/addresstx')
  , Tx = require('../models/tx')
  , Richlist = require('../models/richlist')
  , Peers = require('../models/peers')
  , Heavy = require('../models/heavy')
  , lib = require('./explorer')
  , settings = require('./settings')
  , fs = require('fs')
  , coindesk = require('./apis/coindesk')
  , async = require('async');

function find_address(hash, caseSensitive, cb) {
  if (caseSensitive) {
    // faster search but only matches exact string including case
    Address.findOne({a_id: hash}, function(err, address) {
      if (address)
        return cb(address);
      else
        return cb();
    });
  } else {
    // slower search but matches exact string ignoring case
    Address.findOne({a_id: {$regex: '^' + hash + '$', $options: 'i'}}, function(err, address) {
      if (address)
        return cb(address);
      else
        return cb();
    });
  }
}

function find_address_tx(address, hash, cb) {
  AddressTx.findOne({a_id: address, txid: hash}, function(err, address_tx) {
    if(address_tx) {
      return cb(address_tx);
    } else {
      return cb();
    }
  });
}

function find_richlist(coin, cb) {
  Richlist.findOne({coin: coin}, function(err, richlist) {
    if(richlist) {
      return cb(richlist);
    } else {
      return cb();
    }
  });
}

function update_address(hash, blockheight, txid, amount, type, cb) {
  var to_sent = false;
  var to_received = false;
  var addr_inc = {}
  if ( hash == 'coinbase' ) {
    addr_inc.sent = amount;
  } else {
    if (type == 'vin') {
      addr_inc.sent = amount;
      addr_inc.balance = -amount;
    } else {
      addr_inc.received = amount;
      addr_inc.balance = amount;
    }
  }
  Address.findOneAndUpdate({a_id: hash}, {
    $inc: addr_inc
  }, {
    new: true,
    upsert: true
  }, function (err, address) {
    if (err) {
      return cb(err);
    } else {
      if ( hash != 'coinbase' ) {
        AddressTx.findOneAndUpdate({a_id: hash, txid: txid}, {
          $inc: {
            amount: addr_inc.balance
          },
          $set: {
            a_id: hash,
            blockindex: blockheight,
            txid: txid
          }
        }, {
          new: true,
          upsert: true
        }, function (err,addresstx) {
          if (err) {
            return cb(err);
          } else {
            return cb();
          }
        });
      } else {
        return cb();
      }
    }
  });
}

function find_tx(txid, cb) {
  Tx.findOne({txid: txid}, function(err, tx) {
    if(tx) {
      return cb(tx);
    } else {
      return cb(null);
    }
  });
}

function save_tx(txid, blockheight, cb) {
  lib.get_rawtransaction(txid, function(tx){
    if (tx && tx != 'There was an error. Check your console.') {
      lib.prepare_vin(tx, function(vin) {
        lib.prepare_vout(tx.vout, txid, vin, ((typeof tx.vjoinsplit === 'undefined' || tx.vjoinsplit == null) ? [] : tx.vjoinsplit), function(vout, nvin) {
          lib.syncLoop(vin.length, function (loop) {
            var i = loop.iteration();
            update_address(nvin[i].addresses, blockheight, txid, nvin[i].amount, 'vin', function(){
              loop.next();
            });
          }, function(){
            lib.syncLoop(vout.length, function (subloop) {
              var t = subloop.iteration();
              if (vout[t].addresses) {
                update_address(vout[t].addresses, blockheight, txid, vout[t].amount, 'vout', function(){
                  subloop.next();
                });
              } else {
                subloop.next();
              }
            }, function(){
              lib.calculate_total(vout, function(total){
                var newTx = new Tx({
                  txid: tx.txid,
                  vin: nvin,
                  vout: vout,
                  total: total.toFixed(8),
                  timestamp: tx.time,
                  blockhash: tx.blockhash,
                  blockindex: blockheight,
                });
                newTx.save(function(err) {
                  if (err) {
                    return cb(err, false);
                  } else {
                    return cb(null, vout.length > 0);
                  }
                });
              });
            });
          });
        });
      });
    } else {
      return cb('tx not found: ' + txid, false);
    }
  });
}

function get_market_data(market, cb) {
  if (fs.existsSync('./lib/markets/' + market + '.js')) {
    exMarket = require('./markets/' + market);
    exMarket.get_data(settings.markets, function(err, obj) {
      return cb(err, obj);
    });
  } else {
    return cb(null);
  }
}

function create_lock(lockfile, cb) {
  if (settings.lock_during_index == true) {
    var fname = './tmp/' + lockfile + '.pid';
    fs.appendFile(fname, process.pid.toString(), function (err) {
      if (err) {
        console.log("Error: unable to create %s", fname);
        process.exit(1);
      } else {
        return cb();
      }
    });
  } else {
    return cb();
  }
}

function remove_lock(lockfile, cb) {
  if (settings.lock_during_index == true) {
    var fname = './tmp/' + lockfile + '.pid';
    fs.unlink(fname, function (err){
      if(err) {
        console.log("unable to remove lock: %s", fname);
        process.exit(1);
      } else {
        return cb();
      }
    });
  } else {
    return cb();
  }
}

function is_locked(lockfile, cb) {
  if (settings.lock_during_index == true) {
    var fname = './tmp/' + lockfile + '.pid';
    fs.exists(fname, function (exists){
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  } else {
    return cb(false);
  }
}

module.exports = {
  // initialize DB
  connect: function(database, cb) {
    mongoose.connect(database, { useNewUrlParser: true, useCreateIndex: true, useUnifiedTopology: true, useFindAndModify: false }, function(err) {
      if (err) {
        console.log('Unable to connect to database: %s', database);
        console.log('Aborting');
        process.exit(1);

      }
      //console.log('Successfully connected to MongoDB');
      return cb();
    });
  },

  is_locked: function(cb) {
    is_locked("db_index", function (exists) {
      if (exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  check_show_sync_message: function() {
    return fs.existsSync('./tmp/show_sync_message.tmp');
  },

  update_label: function(hash, claim_name, cb) {
    find_address(hash, false, function(address) {
      if (address) {
        Address.updateOne({a_id: hash}, {
          name: claim_name
        }, function() {
          // update claim name in richlist
          module.exports.update_richlist_claim_name(hash, claim_name, function() {
            // update claim name in masternode list
            module.exports.update_masternode_claim_name(hash, claim_name, function() {
              return cb('');
            });
          });
        });
      } else {
        // address is not valid or does not have any transactions
        return cb('no_address');
      }
    });
  },

  update_richlist_claim_name: function(hash, claim_name, cb) {
    // check if the richlist is enabled
    if (settings.display.richlist) {
      // ensure that if this address exists in the richlist that it displays the new alias
      module.exports.get_richlist(settings.coin, function(richlist) {
        var updated = false;
        // loop through received addresses
        for (r = 0; r < richlist.received.length; r++) {
          // check if this is the correct address
          if (richlist.received[r].a_id == hash) {
            // update the claim name
            richlist.received[r]['name'] = claim_name;
            // mark as updated
            updated = true;
          }
        }
        // loop through balance addresses
        for (b = 0; b < richlist.balance.length; b++) {
          // check if this is the correct address
          if (richlist.balance[b].a_id == hash) {
            // update the claim name
            richlist.balance[b]['name'] = claim_name;
            // mark as updated
            updated = true;                
          }
        }
        // check if the address was updated in the richlist
        if (updated) {
          // save the richlist back to collection
          Richlist.updateOne({coin: settings.coin}, {
            received: richlist.received,
            balance: richlist.balance
          }, function() {
            // finished updating the claim label
            return cb('');
          });
        } else {
          // finished updating the claim label
          return cb('');
        }
      });
    } else {
      // richlist is not enabled so nothing to update
      return cb('');
    }
  },

  update_masternode_claim_name: function(hash, claim_name, cb) {
    // check if the masternode list is enabled
    if (settings.display.masternodes) {
      // ensure that if this address exists in the masternode that it displays the new alias
      module.exports.get_masternodes(function(masternodes) {
        var updated = false;
        // loop through masternode addresses
        for (m = 0; m < masternodes.length; m++) {
          // check if this is the correct address
          if (masternodes[m].addr == hash) {
            // update the claim name
            masternodes[m]['claim_name'] = claim_name;
            // mark as updated
            updated = true;
          }
        }
        // check if the address was updated in the masternode list
        if (updated) {
          // save the updated masternode back to collection
          Masternode.updateOne({addr: hash}, {
            claim_name: claim_name
          }, function() {
            // finished updating the claim label
            return cb('');
          });
        } else {
          // finished updating the claim label
          return cb('');
        }
      });
    } else {
      // masternode list is not enabled so nothing to update
      return cb('');
    }
  },

  check_stats: function(coin, cb) {
    Stats.findOne({coin: coin}, function(err, stats) {
      if(stats) {
		  // collection exists, now check if it is missing the last_usd_price column
		  Stats.findOne({last_usd_price: {$exists: false}}, function(err, stats) {
			  if (stats) {
				// the last_usd_price needs to be added to the collection
				Stats.updateOne({coin: coin}, {
				  last_usd_price: 0,
				}, function() { return cb(null); });
			  }
		  });
		  return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  get_stats: function(coin, cb) {
    Stats.findOne({coin: coin}, function(err, stats) {
      if(stats) {
        return cb(stats);
      } else {
        return cb(null);
      }
    });
  },

  create_stats: function(coin, cb) {
    var newStats = new Stats({
      coin: coin,
      last: 0
    });

    newStats.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial stats entry created for %s", coin);
        //console.log(newStats);
        return cb();
      }
    });
  },

  get_address: function(hash, caseSensitive, cb) {
    find_address(hash, caseSensitive, function(address){
      return cb(address);
    });
  },

  get_richlist: function(coin, cb) {
    find_richlist(coin, function(richlist){
      return cb(richlist);
    });
  },

  // 'list' variable can be either 'received' or 'balance'
  update_richlist: function(list, cb){
    // Create the burn address array so that we omit burned coins from the rich list
    var oBurnAddresses = [];
    for (var x = 0; x < settings.burned_coins.length; x++) {
      oBurnAddresses.push(settings.burned_coins[x].address);
    }
    // always omit the private address from the richlist
    oBurnAddresses.push("private_tx");

    if (list == 'received') {
      // Update 'received' richlist data
      Address.find({a_id: { $nin: oBurnAddresses }}, 'a_id name balance received').sort({received: 'desc'}).limit(100).exec(function(err, addresses) {
        Richlist.updateOne({coin: settings.coin}, {
          received: addresses
        }, function() {
          return cb();
        });
      });
    } else {
      // Update 'balance' richlist data
      Address.find({a_id: { $nin: oBurnAddresses }}, 'a_id name balance received').sort({balance: 'desc'}).limit(100).exec(function(err, addresses) {
        Richlist.updateOne({coin: settings.coin}, {
          balance: addresses
        }, function() {
          return cb();
        });
      });
    }
  },

  get_tx: function(txid, cb) {
    find_tx(txid, function(tx){
      return cb(tx);
    });
  },

  get_txs: function(block, cb) {
    var txs = [];
    lib.syncLoop(block.tx.length, function (loop) {
      var i = loop.iteration();
      find_tx(block.tx[i], function(tx){
        if (tx) {
          txs.push(tx);
          loop.next();
        } else {
          loop.next();
        }
      })
    }, function(){
      return cb(txs);
    });
  },

  create_txs: function(block, cb) {
    is_locked("db_index", function (exists) {
      if (exists) {
        console.log("db_index lock file exists...");
        return cb();
      } else {
        lib.syncLoop(block.tx.length, function (loop) {
          var i = loop.iteration();
          save_tx(block.tx[i], block.height, function(err, tx_has_vout) {
            if (err) {
              loop.next();
            } else {
              //console.log('tx stored: %s', block.tx[i]);
              loop.next();
            }
          });
        }, function(){
          return cb();
        });
      }
    });
  },

  get_last_txs: function(start, length, min, internal, cb) {
    this.get_last_txs_ajax(start, length, min, function(txs, count) {
      var data = [];

      for (i = 0; i < txs.length; i++) {
        if (internal) {
          var row = [];
          row.push(txs[i].blockindex);
          row.push(txs[i].blockhash);
          row.push(txs[i].txid);
          row.push(txs[i].vout.length);
          row.push((txs[i].total / 100000000));
          row.push(txs[i].timestamp);
          data.push(row);
        } else {
          data.push({
            blockindex: txs[i].blockindex,
            blockhash: txs[i].blockhash,
            txid: txs[i].txid,
            recipients: txs[i].vout.length,
            amount: (txs[i].total / 100000000),
            timestamp: txs[i].timestamp
          });
        }
      }
      return cb(data, count);
    });
  },

  get_last_txs_ajax: function(start, length, min, cb) {
    // check if min is greater than zero
    if (min > 0) {
      // min is greater than zero which means we must pull record count from the txes collection
      Tx.find({'total': {$gte: min}}).countDocuments(function(err, count) {
        // Get last transactions where there is at least 1 vout
        Tx.find({'total': {$gte: min}, 'vout': { $gte: { $size: 1 }}}).sort({blockindex: -1}).skip(Number(start)).limit(Number(length)).exec(function(err, txs) {
          if (err) {
            return cb(err);
          } else {
            return cb(txs, count);
          }
        });
      });
    } else {
      // min is zero (shouldn't ever be negative) which means we must pull record count from the coinstats collection (pulling from txes could potentially take a long time because it would include coinbase txes)
      Stats.findOne({coin:settings.coin}, function(err, stats) {
        // Get last transactions where there is at least 1 vout
        Tx.find({'total': {$gte: min}, 'vout': { $gte: { $size: 1 }}}).sort({blockindex: -1}).skip(Number(start)).limit(Number(length)).exec(function(err, txs) {
          if (err) {
            return cb(err);
          } else {
            return cb(txs, stats.txes);
          }
        });
      });
    }
  },

  get_address_txs_ajax: function(hash, start, length, cb) {
    var totalCount = 0;
    AddressTx.find({a_id: hash}).countDocuments(function(err, count){
      if(err) {
        return cb(err);
      } else {
        totalCount = count;
        AddressTx.aggregate([
          { $match: { a_id: hash } },
          { $sort: {blockindex: -1} },
          { $skip: Number(start) },
          {
            $group: {
              _id: '',
              balance: { $sum: '$amount' }
            }
          },
          {
            $project: {
              _id: 0,
              balance: '$balance'
            }
          },
          { $sort: {blockindex: -1} }
        ], function (err,balance_sum) {
          if (err) {
            return cb(err);
          } else {
            AddressTx.find({a_id: hash}).sort({blockindex: -1}).skip(Number(start)).limit(Number(length)).exec(function (err, address_tx) {
              if (err) {
                return cb(err);
              } else {
                var txs = [];
                var count = address_tx.length;
                var running_balance = balance_sum.length > 0 ? balance_sum[0].balance : 0;

                var txs = [];

                lib.syncLoop(count, function (loop) {
                  var i = loop.iteration();
                  find_tx(address_tx[i].txid, function (tx) {
                    if (tx && !txs.includes(tx)) {
                      tx.balance = running_balance;
                      txs.push(tx);
                      loop.next();
                    } else if (!txs.includes(tx)) {
                      txs.push("1. Not found");
                      loop.next();
                    } else {
                      loop.next();
                    }
                    running_balance = running_balance - address_tx[i].amount;
                  })
                }, function () {
                  return cb(txs, totalCount);
                });
              }
            });
          }
        });
      }
    });
  },

  create_market: function(coin, exchange, market, cb) {
    var newMarkets = new Markets({
      market: market,
      coin: coin,
      exchange: exchange,
    });

    newMarkets.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial markets entry created for %s", market);
        //console.log(newMarkets);
        return cb();
      }
    });
  },

  // checks market data exists for given market
  check_market: function(market, cb) {
    Markets.findOne({market: market}, function(err, exists) {
      if(exists) {
        return cb(market, true);
      } else {
        return cb(market, false);
      }
    });
  },

  // gets market data for given market
  get_market: function(market, cb) {
    Markets.findOne({market: market}, function(err, data) {
      if(data) {
        return cb(data);
      } else {
        return cb(null);
      }
    });
  },

  // creates initial richlist entry in database; called on first launch of explorer
  create_richlist: function(coin, cb) {
    var newRichlist = new Richlist({
      coin: coin,
    });
    newRichlist.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial richlist entry created for %s", coin);
        //console.log(newRichlist);
        return cb();
      }
    });
  },

  // drops richlist data for given coin
  delete_richlist: function(coin, cb) {
    Richlist.findOneAndRemove({coin: coin}, function(err, exists) {
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },
  // checks richlist data exists for given coin
  check_richlist: function(coin, cb) {
    Richlist.findOne({coin: coin}, function(err, exists) {
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  create_heavy: function(coin, cb) {
    var newHeavy = new Heavy({
      coin: coin,
    });
    newHeavy.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        console.log("initial heavy entry created for %s", coin);
        console.log(newHeavy);
        return cb();
      }
    });
  },

  check_heavy: function(coin, cb) {
    Heavy.findOne({coin: coin}, function(err, exists) {
      if(exists) {
        return cb(true);
      } else {
        return cb(false);
      }
    });
  },

  get_heavy: function(coin, cb) {
    Heavy.findOne({coin: coin}, function(err, heavy) {
      if(heavy) {
        return cb(heavy);
      } else {
        return cb(null);
      }
    });
  },
  get_distribution: function(richlist, stats, cb){
    var distribution = {
      supply: stats.supply,
      t_1_25: {percent: 0, total: 0 },
      t_26_50: {percent: 0, total: 0 },
      t_51_75: {percent: 0, total: 0 },
      t_76_100: {percent: 0, total: 0 },
      t_101plus: {percent: 0, total: 0 }
    };
    lib.syncLoop(richlist.balance.length, function (loop) {
      var i = loop.iteration();
      var count = i + 1;
      var percentage = ((richlist.balance[i].balance / 100000000) / stats.supply) * 100;
      if (count <= 25 ) {
        distribution.t_1_25.percent = distribution.t_1_25.percent + percentage;
        distribution.t_1_25.total = distribution.t_1_25.total + (richlist.balance[i].balance / 100000000);
      }
      if (count <= 50 && count > 25) {
        distribution.t_26_50.percent = distribution.t_26_50.percent + percentage;
        distribution.t_26_50.total = distribution.t_26_50.total + (richlist.balance[i].balance / 100000000);
      }
      if (count <= 75 && count > 50) {
        distribution.t_51_75.percent = distribution.t_51_75.percent + percentage;
        distribution.t_51_75.total = distribution.t_51_75.total + (richlist.balance[i].balance / 100000000);
      }
      if (count <= 100 && count > 75) {
        distribution.t_76_100.percent = distribution.t_76_100.percent + percentage;
        distribution.t_76_100.total = distribution.t_76_100.total + (richlist.balance[i].balance / 100000000);
      }
      loop.next();
    }, function(){
      distribution.t_101plus.percent = parseFloat(100 - distribution.t_76_100.percent - distribution.t_51_75.percent - distribution.t_26_50.percent - distribution.t_1_25.percent).toFixed(2);
      distribution.t_101plus.total = parseFloat(distribution.supply - distribution.t_76_100.total - distribution.t_51_75.total - distribution.t_26_50.total - distribution.t_1_25.total).toFixed(8);
      distribution.t_1_25.percent = parseFloat(distribution.t_1_25.percent).toFixed(2);
      distribution.t_1_25.total = parseFloat(distribution.t_1_25.total).toFixed(8);
      distribution.t_26_50.percent = parseFloat(distribution.t_26_50.percent).toFixed(2);
      distribution.t_26_50.total = parseFloat(distribution.t_26_50.total).toFixed(8);
      distribution.t_51_75.percent = parseFloat(distribution.t_51_75.percent).toFixed(2);
      distribution.t_51_75.total = parseFloat(distribution.t_51_75.total).toFixed(8);
      distribution.t_76_100.percent = parseFloat(distribution.t_76_100.percent).toFixed(2);
      distribution.t_76_100.total = parseFloat(distribution.t_76_100.total).toFixed(8);
      return cb(distribution);
    });
  },

  // updates heavy stats for coin
  // height: current block height, count: amount of votes to store
  update_heavy: function(coin, height, count, cb) {
    var newVotes = [];

    lib.get_maxmoney( function (maxmoney) {
      lib.get_maxvote( function (maxvote) {
        lib.get_vote( function (vote) {
          lib.get_phase( function (phase) {
            lib.get_reward( function (reward) {
              lib.get_supply( function (supply) {
                lib.get_estnext( function (estnext) {
                  lib.get_nextin( function (nextin) {
                    lib.syncLoop(count, function (loop) {
                      var i = loop.iteration();
                      lib.get_blockhash(height - i, function (hash) {
                        lib.get_block(hash, function (block) {
                          newVotes.push({ count: height - i, reward: block.reward, vote: (block && block.vote ? block.vote : 0) });
                          loop.next();
                        });
                      });
                    }, function() {
                      Heavy.updateOne({coin: coin}, {
                        lvote: (vote ? vote : 0),
                        reward: (reward ? reward : 0),
                        supply: (supply ? supply : 0),
                        cap: (maxmoney ? maxmoney : 0),
                        estnext: (estnext ? estnext : 0),
                        phase: (phase ? phase : 'N/A'),
                        maxvote: (maxvote ? maxvote : 0),
                        nextin: (nextin ? nextin : 'N/A'),
                        votes: newVotes
                      }, function() {
                        // update reward_last_updated value
                        module.exports.update_last_updated_stats(settings.coin, { reward_last_updated: Math.floor(new Date() / 1000) }, function (new_cb) {
                          console.log('heavy update complete');
                          return cb();
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  },

  // updates market data for given market; called by sync.js
  update_markets_db: function(market, cb) {
    // check if market exists
    if (fs.existsSync('./lib/markets/' + market + '.js')) {
      get_market_data(market, function (err, obj) {
        if (err == null) {
          Markets.updateOne({market:market}, {
            chartdata: JSON.stringify(obj.chartdata),
            buys: obj.buys,
            sells: obj.sells,
            history: obj.trades,
            summary: obj.stats
          }, function() {
            if ( market == settings.markets.default ) {
              Stats.updateOne({coin:settings.coin}, {
                last_price: obj.stats.last,
              }, function(){
                return cb(null);
              });
            } else {
              return cb(null);
            }
          });
        } else {
          return cb(err);
        }
      });
    } else {
      // market does not exist
      return cb('market is not installed');
    }
  },
  
  get_last_usd_price: function(cb) {
	// Check if the market price is being recorded in BTC
	if (settings.markets.enabled.length > 0 && settings.markets.exchange.toLowerCase() == "btc") {
	  // Convert btc to usd via coindesk api
	  coindesk.get_data(function (err, last_usd) {
		// Get current stats
		Stats.findOne({coin:settings.coin}, function(err, stats) {
			// Update the last usd price
			Stats.updateOne({coin:settings.coin}, {
			  last_usd_price: (last_usd * stats.last_price),
			}, function(){
			  return cb(null);
			});
		});
	  });
	} else {
		return cb(null);
	}
  },

  // updates stats data for given coin; called by sync.js
  update_db: function(coin, cb) {
    lib.get_blockcount( function (count) {
      if (!count) {
        console.log('Unable to connect to explorer API');
        return cb(false);
      }
      lib.get_supply( function (supply) {
        lib.get_connectioncount(function (connections) {
          Stats.findOne({coin: coin}, function(err, stats) {
            if (stats) {
              Stats.updateOne({coin: coin}, {
                coin: coin,
                count : count,
                supply: (supply ? supply : 0),
                connections: (connections ? connections : 0)
              }, function(err) {
                if (err) {
                  console.log("Error during Stats Update: ", err);
                }
                return cb({
                  coin: coin,
                  count : count,
                  supply: (supply ? supply : 0),
                  connections: (connections ? connections : 0),
                  last: (stats.last ? stats.last : 0),
                  txes: (stats.txes ? stats.txes : 0)
                });
              });
            } else {
              console.log("Error during Stats Update: ", (err ? err : 'cannot find stats collection'));
              return cb(false);
            }
          });
        });
      });
    });
  },

  // updates tx, address & richlist db's; called by sync.js
  update_tx_db: function(coin, start, end, txes, timeout, cb) {
    is_locked("db_index", function (exists) {
      if (exists) {
        console.log("db_index lock file exists...");
        return cb();
      } else {
        create_lock("db_index", function (){
          var complete = false;
          var blocks_to_scan = [];
          var task_limit_blocks = settings.block_parallel_tasks;
          if (typeof start === 'undefined' || start < 1) start = 1; // fix for invalid block height (skip genesis block as it should not have valid txs)
          if (task_limit_blocks < 1) { task_limit_blocks = 1; }
          var task_limit_txs = 1;
          for (i=start; i<(end+1); i++) {
            blocks_to_scan.push(i);
          }
          async.eachLimit(blocks_to_scan, task_limit_blocks, function(block_height, next_block) {
            if (block_height % settings.save_stats_after_sync_blocks === 0) {
              Stats.updateOne({coin: coin}, {
                last: block_height - 1,
                txes: txes,
                last_txs: '' //not used anymore left to clear out existing objects
              }, function() {});
            }
            lib.get_blockhash(block_height, function(blockhash){
              if (blockhash) {
                lib.get_block(blockhash, function(block) {
                  if (block) {
                    async.eachLimit(block.tx, task_limit_txs, function(txid, next_tx) {
                      Tx.findOne({txid: txid}, function(err, tx) {
                        if(tx) {
                          setTimeout( function(){
                            tx = null;
                            next_tx();
                          }, timeout);
                        } else {
                          save_tx(txid, block_height, function(err, tx_has_vout) {
                            if (err) {
                              console.log(err);
                            } else {
                              console.log('%s: %s', block_height, txid);
                            }
                            if (tx_has_vout)
                              txes++;
                            setTimeout( function(){
                              tx = null;
                              next_tx();
                            }, timeout);
                          });
                        }
                      });
                    }, function(){
                      setTimeout( function(){
                        blockhash = null;
                        block = null;
                        next_block();
                      }, timeout);
                    });
                  } else {
                    console.log('block not found: %s', blockhash);
                    setTimeout( function(){
                      next_block();
                    }, timeout);
                  }
                });
              } else {
                setTimeout( function(){
                  next_block();
                }, timeout);
              }
            });
          }, function(){
            Tx.find({}).sort({timestamp: 'desc'}).limit(settings.index.last_txs).exec(function(err, txs){
              Stats.updateOne({coin: coin}, {
                last: end,
                txes: txes,
                last_txs: '' //not used anymore left to clear out existing objects
              }, function() {
                remove_lock("db_index", function(){
                  return cb();
                });
              });
            });
          });
        });
      }
    });
  },

  create_peer: function(params, cb) {
    var newPeer = new Peers(params);
    newPeer.save(function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb();
      }
    });
  },

  find_peer: function(address, cb) {
    Peers.findOne({address: address}, function(err, peer) {
      if (err) {
        return cb(null);
      } else {
        if (peer) {
         return cb(peer);
       } else {
         return cb (null)
       }
      }
    })
  },

  drop_peer: function(address, cb) {
    Peers.deleteOne({address: address}, function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb ()
      }
    })
  },

  drop_peers: function(cb) {
    Peers.deleteMany({}, function(err) {
      if (err) {
        console.log(err);
        return cb();
      } else {
        return cb ()
      }
    })
  },

  get_peers: function(cb) {
    Peers.find({}, function(err, peers) {
      if (err) {
        return cb([]);
      } else {
        return cb(peers);
      }
    });
  },

  // determine if masternode exists and save masternode to collection
  save_masternode: function (raw_masternode, cb) {
    // lookup masternode in local collection
    module.exports.find_masternode(raw_masternode.txhash, raw_masternode.outidx, function (masternode) {
      // determine if the claim address feature is enabled
      if (settings.display.claim_address) {
        // claim address is enabled so lookup the address claim name
        find_address(raw_masternode.addr, false, function(address) {
          if (address) {
            // save claim name to masternode obejct
            raw_masternode.claim_name = address.name;
          } else {
            // save blank claim name to masternode obejct
            raw_masternode.claim_name = '';
          }
          // add/update the masternode
          module.exports.add_update_masternode(raw_masternode, (masternode == null), function(success) {
            return cb(success);
          });
        });
      } else {
        // claim address is disabled so add/update the masternode
        module.exports.add_update_masternode(raw_masternode, (masternode == null), function(success) {
          return cb(success);
        });
      }
    });
  },

  // add or update a single masternode
  add_update_masternode(masternode, add, cb) {
    if (!masternode.txhash == null || !masternode.outidx == null) {
      console.log('Masternode Update - TX or Outidx is missing');
      console.log(masternode.txhash);
      console.log(masternode.outidx);
      return cb(false);
    } else {
      var mn = new Masternode({
        rank: masternode.rank,
        network: masternode.network,
        txhash: masternode.txhash,
        outidx: masternode.outidx,
        status: masternode.status,
        addr: masternode.addr,
        version: masternode.version,
        lastseen: masternode.lastseen,
        activetime: masternode.activetime,
        lastpaid: masternode.lastpaid,
        claim_name: (masternode.claim_name == null ? '' : masternode.claim_name)
      });

      if (add) {
        // add new masternode to collection
        mn.save(function (err) {
          if (err) {
            console.log(err);
            return cb(false);
          } else
            return cb(true);
        });
      } else {
        // update existing masternode in local collection
        Masternode.updateOne({ txhash: masternode.txhash, outidx: masternode.outidx }, masternode, function (err) {
          if (err) {
            console.log(err);
            return cb(false);
          } else
            return cb(true);
        });
      }
    }
  },

  // find masternode by txid and offset
  find_masternode: function (txhash, outidx, cb) {
    Masternode.findOne({ txhash: txhash, outidx: outidx }, function (err, masternode) {
      if (err)
        return cb(null);
      else {
        if (masternode)
          return cb(masternode);
        else
          return cb(null);
      }
    });
  },

  // remove masternodes older than 24 hours
  remove_old_masternodes: function (cb) {
    Masternode.deleteMany({ lastseen: { $lte: (Math.floor(Date.now() / 1000) - 86400) } }, function (err) {
      if (err) {
        console.log(err);
        return cb();
      } else
        return cb();
    });
  },

  // get the list of masternodes from local collection
  get_masternodes: function (cb) {
    Masternode.find({}, function (err, masternodes) {
      if (err)
        return cb([]);
      else
        return cb(masternodes);
    });
  },

  get_masternode_rewards: function(mnPayees, since, cb) {
    Tx.aggregate([
      { $match: {
        "blockindex": { $gt: Number(since) },
        "vin": []
      }},
      { "$unwind": "$vout" },
      { $match: {
        "vout.addresses": { $in: [mnPayees] }
      }}
    ], function(err, data) {
      if (err) {
        console.log(err);
        return cb(null);
      } else
        return cb(data);
    });
  },

  get_masternode_rewards_totals: function(mnPayees, since, cb) {
    Tx.aggregate([
      { $match: {
        "blockindex": { $gt: Number(since) },
        "vin": []
      }},
      { "$unwind": "$vout" },
      { $match: {
        "vout.addresses": { $in: [mnPayees] }
      }},
      { $group: { _id: null, total: { $sum: "$vout.amount" } } }
    ], function(err, data) {
      if (err) {
        console.log(err);
        return cb(null);
      } else
        return cb((data.length > 0 ? data[0].total / 100000000 : 0));
    });
  },

  // updates last_updated stats; called by sync.js
  update_last_updated_stats: function (coin, param, cb) {
    if (param.blockchain_last_updated) {
      // update blockchain last updated date
      Stats.updateOne({ coin: coin }, {
        blockchain_last_updated: param.blockchain_last_updated
      }, function () {
        return cb(true);
      });
    } else if (param.reward_last_updated) {
      // update reward last updated date
      Stats.updateOne({ coin: coin }, {
        reward_last_updated: param.reward_last_updated
      }, function () {
        return cb(true);
      });
    } else if (param.masternodes_last_updated) {
      // update masternode last updated date
      Stats.updateOne({ coin: coin }, {
        masternodes_last_updated: param.masternodes_last_updated
      }, function () {
        return cb(true);
      });
    } else if (param.network_last_updated) {
      // update network last updated date
      Stats.updateOne({ coin: coin }, {
        network_last_updated: param.network_last_updated
      }, function () {
        return cb(true);
      });
    } else if (param.richlist_last_updated) {
      // update richlist last updated date
      Stats.updateOne({ coin: coin }, {
        richlist_last_updated: param.richlist_last_updated
      }, function () {
        return cb(true);
      });
    } else if (param.markets_last_updated) {
      // update markets last updated date
      Stats.updateOne({ coin: coin }, {
        markets_last_updated: param.markets_last_updated
      }, function () {
        return cb(true);
      });
    } else {
      // invalid option
      return cb(false);
    }
  },

  populate_claim_address_names: function(tx, cb) {
    var addresses = [];

    // loop through vin addresses
    tx.vin.forEach(function (vin) {
      // check if this address already exists
      if (addresses.indexOf(vin.addresses) == -1) {
        // add address to array
        addresses.push(vin.addresses);
      }
    });

    // loop through vout addresses
    tx.vout.forEach(function (vout) {
      // check if this address already exists
      if (addresses.indexOf(vout.addresses) == -1) {
        // add address to array
        addresses.push(vout.addresses);
      }
    });

    // loop through address array
    lib.syncLoop(addresses.length, function (loop) {
      var a = loop.iteration();

      module.exports.get_address(addresses[a], false, function(address) {
        if (address && address.name != null && address.name != '') {
          // look for address in vin
          for (v = 0; v < tx.vin.length; v++) {
            // check if this is the correct address
            if (tx.vin[v].addresses == address.a_id) {
              // add claim name to array
              tx.vin[v]['claim_name'] = address.name;
            }
          }

          // look for address in vout
          for (v = 0; v < tx.vout.length; v++) {
            // check if this is the correct address
            if (tx.vout[v].addresses == address.a_id) {
              // add claim name to array
              tx.vout[v]['claim_name'] = address.name;
            }
          }
        }

        loop.next();
      });
    }, function() {
      // return modified tx object
      return cb(tx);
    });
  },

  fs: fs
};